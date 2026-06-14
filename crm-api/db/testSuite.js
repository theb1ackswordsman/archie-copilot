import dotenv from 'dotenv';
dotenv.config();

const CRM_URL = process.env.CRM_API_URL || 'http://localhost:3001';
const CHANNEL_URL = process.env.CHANNEL_SERVICE_URL || 'http://localhost:3002';

async function runTestSuite() {
  console.log('\x1b[35m%s\x1b[0m', '==================================================');
  console.log('\x1b[35m%s\x1b[0m', '      CAMPAIGN COPILOT INTEGRATION TEST SUITE     ');
  console.log('\x1b[35m%s\x1b[0m', '==================================================\n');

  let passed = 0;
  let failed = 0;

  async function assert(testName, fn) {
    try {
      console.log(`\x1b[36m[RUNNING]\x1b[0m ${testName}`);
      await fn();
      console.log(`\x1b[32m[PASSED]\x1b[0m  ${testName}\n`);
      passed++;
    } catch (err) {
      console.error(`\x1b[31m[FAILED]\x1b[0m  ${testName}`);
      console.error(`          Reason: ${err.message}\n`);
      failed++;
    }
  }

  // --- TEST 1: Health Checks ---
  await assert('Health Checks of both APIs', async () => {
    const crmHealth = await fetch(`${CRM_URL}/health`).then(r => r.json());
    if (crmHealth.status !== 'ok') throw new Error(`CRM health status is: ${crmHealth.status}`);

    const channelHealth = await fetch(`${CHANNEL_URL}/health`).then(r => r.json());
    if (channelHealth.status !== 'ok') throw new Error(`Channel health status is: ${channelHealth.status}`);
  });

  // --- TEST 2: Customer List Validation ---
  await assert('Customers List Endpoint (GET /api/customers)', async () => {
    const res = await fetch(`${CRM_URL}/api/customers`);
    if (!res.ok) throw new Error(`HTTP Error: ${res.status}`);
    const data = await res.json();

    if (!Array.isArray(data)) throw new Error('Response is not an array');
    if (data.length === 0) throw new Error('No customers returned');

    const sample = data[0];
    const requiredKeys = ['id', 'name', 'phone', 'email', 'order_count', 'total_spend'];
    for (const key of requiredKeys) {
      if (!(key in sample)) throw new Error(`Customer is missing key: ${key}`);
    }
    console.log(`          Found ${data.length} customers. Sample: ${sample.name} (Orders: ${sample.order_count}, Spend: $${sample.total_spend})`);
  });

  // --- TEST 3: Segment Preview Validation & Edge Cases ---
  await assert('Segment Preview (GET /api/segments/preview)', async () => {
    // Regular Filter
    const res = await fetch(`${CRM_URL}/api/segments/preview?min_orders=2`);
    if (!res.ok) throw new Error(`HTTP Error: ${res.status}`);
    const data = await res.json();
    if (typeof data.count !== 'number') throw new Error('Segment preview count is not a number');
    if (!Array.isArray(data.sample)) throw new Error('Segment preview sample is not an array');

    console.log(`          Filter [min_orders=2]: Found ${data.count} matching customers`);

    // Edge Case: Unrealistic High Filters (should return 0)
    const emptyRes = await fetch(`${CRM_URL}/api/segments/preview?min_spend=999999`);
    const emptyData = await emptyRes.json();
    if (emptyData.count !== 0) throw new Error(`Expected 0 matching customers, got ${emptyData.count}`);
    if (emptyData.sample.length !== 0) throw new Error('Expected sample array to be empty');
    console.log('          Filter [min_spend=999999] (Edge Case): Returned 0 count and empty sample correctly');
  });

  // --- TEST 4: Campaign End-to-End Callback Flow ---
  await assert('Campaign Dispatch & Delivery Lifecycle (POST /api/campaigns)', async () => {
    // Create a targeted campaign using tags to keep recipient count small (e.g. VIP tag)
    const payload = {
      name: 'Integration Test Promo',
      channel: 'whatsapp',
      message: 'Hello {{name}}, here is your test offer!',
      filters: {
        tags_include: ['VIP'],
        min_orders: 1
      }
    };

    const dispatchRes = await fetch(`${CRM_URL}/api/campaigns`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!dispatchRes.ok) throw new Error(`Campaign creation failed with status: ${dispatchRes.status}`);
    const campaign = await dispatchRes.json();
    if (!campaign.id) throw new Error('Campaign response did not return a campaign ID');
    console.log(`          Campaign created with ID: ${campaign.id}. Waiting for async channel service callbacks...`);

    // Wait 5 seconds to let async timeouts in the channel service run and trigger callbacks
    console.log('          [WAITING] 5 seconds for simulated delivery events to fire...');
    await new Promise(resolve => setTimeout(resolve, 5000));

    // Verify campaign detail and message stats
    const detailRes = await fetch(`${CRM_URL}/api/campaigns/${campaign.id}`);
    if (!detailRes.ok) throw new Error(`Failed to fetch campaign details: ${detailRes.status}`);
    const detail = await detailRes.json();

    if (detail.id !== campaign.id) throw new Error('Returned incorrect campaign ID');
    if (!detail.stats) throw new Error('Campaign detail is missing aggregate stats');
    
    const stats = detail.stats;
    console.log(`          Campaign Stats - Sent: ${stats.sent}, Delivered: ${stats.delivered}, Opened: ${stats.opened}, Failed: ${stats.failed}`);
    
    if (stats.sent === 0 && stats.failed === 0) {
      throw new Error('No message dispatches registered in statistics.');
    }
  });

  // --- TEST 5: Edge Case: 0-Recipient Campaign Creation ---
  await assert('Edge Case: Campaign Dispatch to 0 Recipients', async () => {
    const payload = {
      name: 'Empty Target Campaign',
      channel: 'sms',
      message: 'Hello, this campaign targets no one!',
      filters: {
        min_spend: 999999 // Matches nobody
      }
    };

    const res = await fetch(`${CRM_URL}/api/campaigns`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!res.ok) throw new Error(`Expected success, got HTTP ${res.status}`);
    const campaign = await res.json();
    
    // Should create the campaign metadata successfully
    if (!campaign.id) throw new Error('Expected campaign to be registered');
    
    // Check that detail reports zero messages
    const detailRes = await fetch(`${CRM_URL}/api/campaigns/${campaign.id}`);
    const detail = await detailRes.json();
    if (detail.messages.length !== 0) {
      throw new Error(`Expected 0 messages, found ${detail.messages.length}`);
    }
    console.log('          Successfully handled empty target campaign without crashing or hangs');
  });

  // --- TEST 6: Edge Case: Invalid inputs to endpoints ---
  await assert('Edge Case: Missing parameters on Campaign Creation', async () => {
    const payload = {
      name: 'Incomplete Campaign'
      // Missing message, channel, filters
    };

    const res = await fetch(`${CRM_URL}/api/campaigns`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (res.status !== 400 && res.status !== 500) {
      throw new Error(`Expected HTTP 400 or 500 bad request, got ${res.status}`);
    }
    console.log(`          Correctly rejected invalid payload with status: ${res.status}`);
  });

  await assert('Edge Case: Invalid Campaign Callback Receipts', async () => {
    const invalidReceipt = {
      message_id: '00000000-0000-0000-0000-000000000000',
      campaign_id: '00000000-0000-0000-0000-000000000000',
      status: 'DELIVERED',
      timestamp: new Date().toISOString()
    };

    const res = await fetch(`${CRM_URL}/api/receipts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(invalidReceipt)
    });

    // It should handle the receipt gracefully (e.g., return 404 or log warning and not crash)
    if (res.status !== 404 && res.status !== 200) {
      throw new Error(`Expected 404 Not Found or graceful 200, got status: ${res.status}`);
    }
    console.log(`          Correctly responded to non-existent callback with status: ${res.status}`);
  });

  console.log('\x1b[35m%s\x1b[0m', '==================================================');
  console.log(`  TEST RUN FINISHED. PASSED: ${passed} | FAILED: ${failed}`);
  console.log('\x1b[35m%s\x1b[0m', '==================================================');

  if (failed > 0) {
    process.exit(1);
  }
}

runTestSuite().catch(err => {
  console.error('Fatal test runner error:', err);
  process.exit(1);
});
