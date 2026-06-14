import { getSegmentedCustomers } from './services/segmentEngine.js';

async function run() {
  try {
    const customers = await getSegmentedCustomers({
      sort_by: 'recent_orders',
      last_purchase_days_lt: 30,
      limit: 5
    });
    console.log(`Found ${customers.length} customers.`);
    console.log(customers.map(c => c.name));
  } catch (err) {
    console.error('Error:', err);
  }
}
run();
