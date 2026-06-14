import { previewSegment } from '../services/segmentEngine.js';

async function runTests() {
  console.log('--- Running Segment Engine Tests ---');

  // Test 1: No filters (should return all seeded customers, i.e., count = 200)
  try {
    const res1 = await previewSegment({});
    console.log('Test 1 (No filters):', res1);
  } catch (err) {
    console.error('Test 1 failed:', err.message);
  }

  // Test 2: Inactive customers (> 90 days since last purchase)
  try {
    const res2 = await previewSegment({ last_purchase_days_gt: 90 });
    console.log('Test 2 (last_purchase_days_gt: 90):', res2);
  } catch (err) {
    console.error('Test 2 failed:', err.message);
  }

  // Test 3: VIP tags with at least 2 orders
  try {
    const res3 = await previewSegment({ min_orders: 2, tags_include: ['VIP'] });
    console.log('Test 3 (min_orders: 2, tags_include: ["VIP"]):', res3);
  } catch (err) {
    console.error('Test 3 failed:', err.message);
  }

  // Test 4: Active spenders, excluding Inactive tags
  try {
    const res4 = await previewSegment({
      min_spend: 100,
      tags_exclude: ['Inactive']
    });
    console.log('Test 4 (min_spend: 100, tags_exclude: ["Inactive"]):', res4);
  } catch (err) {
    console.error('Test 4 failed:', err.message);
  }

  console.log('--- Segment Engine Tests Finished ---');
}

runTests().catch(console.error);
