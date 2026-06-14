import { supabase } from './supabase.js';
import { faker } from '@faker-js/faker';

async function seed() {
  console.log('Starting database seed...');

  // 1. Generate 200 Customers
  const customerTags = ['VIP', 'New', 'Inactive', 'Fashion', 'Beauty', 'Skincare', 'Footwear', 'Accessories'];
  const customers = [];

  for (let i = 0; i < 200; i++) {
    // Assign 0 to 3 random tags
    const numTags = faker.number.int({ min: 0, max: 3 });
    const shuffled = [...customerTags].sort(() => 0.5 - Math.random());
    const selectedTags = shuffled.slice(0, numTags);

    customers.push({
      name: faker.person.fullName(),
      phone: faker.phone.number(),
      email: faker.internet.email().toLowerCase(),
      tags: selectedTags,
      created_at: faker.date.past({ years: 1 })
    });
  }

  console.log('Inserting customers into Supabase...');
  const { data: insertedCustomers, error: customerError } = await supabase
    .from('customers')
    .insert(customers)
    .select('id');

  if (customerError) {
    console.error('Error inserting customers:', customerError);
    process.exit(1);
  }

  console.log(`Successfully inserted ${insertedCustomers.length} customers.`);

  // Extract customer IDs
  const customerIds = insertedCustomers.map(c => c.id);

  // 2. Generate 500 Orders
  const orders = [];
  for (let i = 0; i < 500; i++) {
    const randomCustomerId = faker.helpers.arrayElement(customerIds);
    orders.push({
      customer_id: randomCustomerId,
      amount: parseFloat(faker.commerce.price({ min: 15, max: 350, dec: 2 })),
      created_at: faker.date.past({ years: 1 })
    });
  }

  console.log('Inserting orders into Supabase...');
  const { data: insertedOrders, error: orderError } = await supabase
    .from('orders')
    .insert(orders)
    .select('id');

  if (orderError) {
    console.error('Error inserting orders:', orderError);
    process.exit(1);
  }

  console.log(`Successfully inserted ${insertedOrders.length} orders.`);
  console.log('Database seeding completed successfully!');
}

seed().catch(err => {
  console.error('Seed script failed:', err);
  process.exit(1);
});
