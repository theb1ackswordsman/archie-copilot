import { supabase } from '../db/supabase.js';

/**
 * Retrieves and filters the actual customer database records based on purchase behavior.
 * 
 * @param {Object} filters 
 * @returns {Promise<Array>} List of matching customer records
 */
export async function getSegmentedCustomers(filters = {}) {
  // If we have a sort_by === 'recent_orders', we do an aggregate query using Supabase
  if (filters.sort_by === 'recent_orders') {
    const days = filters.last_purchase_days_lt || 30;
    const dateLimit = new Date();
    dateLimit.setDate(dateLimit.getDate() - days);

    // Optimized group by query for top customers
    const { data: topOrders, error: aggError } = await supabase
      .from('orders')
      .select('customer_id, id.count()')
      .gte('created_at', dateLimit.toISOString())
      .order('count', { ascending: false })
      .limit(filters.limit || 5);

    if (aggError) {
      console.warn('Aggregate query failed, falling back to JS sort:', aggError.message);
      // Fallback if aggregate syntax is not supported by the current PostgREST version
    } else if (topOrders && topOrders.length > 0) {
      const customerIds = topOrders.map(o => o.customer_id);

      const { data: customers, error: custError } = await supabase
        .from('customers')
        .select('id, name, phone, email, tags, created_at, orders(amount, created_at)')
        .in('id', customerIds);

      if (custError) throw custError;

      // Order the results to match the sorted customerIds
      const orderedCustomers = customerIds.map(id => customers.find(c => c.id === id)).filter(Boolean);
      return orderedCustomers;
    } else {
      return [];
    }
  }

  // Fallback / standard processing for other filters
  const { data: customers, error } = await supabase
    .from('customers')
    .select('id, name, phone, email, tags, created_at, orders(amount, created_at)');

  if (error) {
    throw error;
  }

  const now = new Date();

  let filtered = customers.filter(customer => {
    const orders = customer.orders || [];
    const orderCount = orders.length;
    const totalSpend = orders.reduce((sum, o) => sum + parseFloat(o.amount || 0), 0);
    
    let lastPurchaseDate = null;
    let daysSinceLastPurchase = null;

    if (orderCount > 0) {
      const dates = orders.map(o => new Date(o.created_at));
      lastPurchaseDate = new Date(Math.max(...dates));
      daysSinceLastPurchase = (now - lastPurchaseDate) / (1000 * 60 * 60 * 24);
    }

    if (filters.last_purchase_days_gt !== undefined && filters.last_purchase_days_gt !== null) {
      if (daysSinceLastPurchase !== null && daysSinceLastPurchase <= filters.last_purchase_days_gt) return false;
    }
    if (filters.last_purchase_days_lt !== undefined && filters.last_purchase_days_lt !== null) {
      if (daysSinceLastPurchase === null || daysSinceLastPurchase >= filters.last_purchase_days_lt) return false;
    }
    if (filters.min_spend !== undefined && filters.min_spend !== null) {
      if (totalSpend < filters.min_spend) return false;
    }
    if (filters.max_spend !== undefined && filters.max_spend !== null) {
      if (totalSpend > filters.max_spend) return false;
    }
    if (filters.min_orders !== undefined && filters.min_orders !== null) {
      if (orderCount < filters.min_orders) return false;
    }
    if (filters.tags_include && Array.isArray(filters.tags_include) && filters.tags_include.length > 0) {
      const hasAllTags = filters.tags_include.every(t => (customer.tags || []).includes(t));
      if (!hasAllTags) return false;
    }
    if (filters.tags_exclude && Array.isArray(filters.tags_exclude) && filters.tags_exclude.length > 0) {
      const hasAnyExcludedTag = filters.tags_exclude.some(t => (customer.tags || []).includes(t));
      if (hasAnyExcludedTag) return false;
    }

    return true;
  });

  if (filters.sort_by === 'total_spend') {
    filtered.sort((a, b) => {
      const aSpend = (a.orders || []).reduce((sum, o) => sum + parseFloat(o.amount || 0), 0);
      const bSpend = (b.orders || []).reduce((sum, o) => sum + parseFloat(o.amount || 0), 0);
      return bSpend - aSpend;
    });
  } else if (filters.sort_by === 'recent_orders') {
    // If we fell back due to aggregate query failure
    filtered.sort((a, b) => {
      const days = filters.last_purchase_days_lt || 30;
      const dateLimit = new Date();
      dateLimit.setDate(dateLimit.getDate() - days);
      
      const aRecent = (a.orders || []).filter(o => new Date(o.created_at) >= dateLimit).length;
      const bRecent = (b.orders || []).filter(o => new Date(o.created_at) >= dateLimit).length;
      return bRecent - aRecent;
    });
  }

  if (filters.limit) {
    filtered = filtered.slice(0, filters.limit);
  }

  return filtered;
}

/**
 * Returns a summary preview (count + sample names) of a customer segment.
 * 
 * @param {Object} filters
 * @returns {Promise<{ count: number, sample: string[] }>}
 */
export async function previewSegment(filters = {}) {
  const filtered = await getSegmentedCustomers(filters);
  return {
    count: filtered.length,
    sample: filtered.slice(0, 5).map(c => c.name)
  };
}
