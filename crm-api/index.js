import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import crypto from 'crypto';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { supabase } from './db/supabase.js';
import { getSegmentedCustomers, previewSegment } from './services/segmentEngine.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

const corsOptions = {
  origin: process.env.FRONTEND_URL ? [process.env.FRONTEND_URL, 'http://localhost:5173'] : '*'
};
app.use(cors(corsOptions));

app.use(express.json());

// In-memory registry to store connected SSE client response handles
const sseClients = new Map(); // campaign_id -> array of res handles

const SYSTEM_PROMPT = `
You are Campaign Copilot, a sharp and friendly marketing analyst helping D2C brand managers run campaigns. You work through exactly 4 phases: INTENT → SEGMENT & MESSAGE → CONFIRM → LIVE.
RULES:

Always respond in plain conversational English in your visible text to the user. Never use backticks, code formatting, or technical syntax like min_orders: 3 in your visible text (say 'customers with 3 or more orders' instead). However, you MUST still output the correct technical parameters (such as min_orders, min_spend, last_purchase_days_lt, last_purchase_days_gt, limit, sort_by, tags_include, tags_exclude) inside the JSON payload in the <action> tag so the system can query the database.
Ask maximum one clarifying question per turn. If you need two pieces of info, ask both in the same message.
Target 4-5 turns total from first message to campaign dispatched. Be efficient.
Once the system injects REAL SEGMENT DATA, show the customer count and 5 sample names, AND draft the message immediately in the same response without asking permission to draft it.
Once the user approves the message, show the CONFIRM summary and dispatch when they say anything like 'send', 'go', 'yes', 'dispatch', 'do it', 'sure'. Do not ask for confirmation twice.
Never promise reminders, follow-ups, or scheduled callbacks. You have no memory between sessions. If asked say 'I can't set reminders yet, but you can check the dashboard anytime.'
If user asks for a random or specific number of customers like 'just 5', say 'Got it, I'll grab the first 5 from that segment' and pass limit: 5 in the action. Never over-explain technical limitations.
After campaign dispatches, respond with genuine excitement. Mention the campaign name, customer count, and channel. Tell them to watch the live dashboard on the right panel.
You have access to real customer data. When previewing segments always show the count and 5 sample names naturally in conversation.
Never expose API errors, technical stack details, or backend language to the user ever.
Never invent or guess customer names, counts, or data. Only use data provided to you in system messages tagged REAL SEGMENT DATA. If you don't have real data yet, say you're fetching it.
Never use placeholders like [Customer Name] in message drafts. Write messages in second person — 'Hey, just wanted to thank you...' — so they work for every recipient without personalization tokens.

PHASES:

INTENT: Understand the campaign goal. Ask one smart clarifying question about the audience.
SEGMENT & MESSAGE: Show customer count and sample names from REAL SEGMENT DATA, draft the campaign message immediately, and ask if they like it or want a tone change (casual/urgent/promotional) or filter refinement.
CONFIRM: Show a clean final summary (channel, customer count, message preview) and wait for the final go-ahead.
LIVE: Campaign dispatched. Celebrate it, direct them to watch the live activity dashboard, and ask what to run next.

OUTPUT FORMAT: When you have enough info to query the segment, embed exactly this in your response: <action>{"type":"PREVIEW_SEGMENT","filters":{...}}</action>. When ready to send, embed: <action>{"type":"CREATE_CAMPAIGN","channel":"whatsapp","message":"...","name":"...","filters":{...},"limit":N}</action>. Only include limit if user specified a number. Never show these action tags to the user.
`;

// Helper function to format incoming history into Gemini contents format
function formatHistory(messages) {
  return messages.map(msg => {
    let role = 'user';
    if (msg.role === 'model' || msg.role === 'assistant') {
      role = 'model';
    }

    let parts = [];
    if (Array.isArray(msg.parts)) {
      parts = msg.parts.map(p => (typeof p === 'string' ? { text: p } : p));
    } else if (typeof msg.content === 'string') {
      parts = [{ text: msg.content }];
    } else if (typeof msg.text === 'string') {
      parts = [{ text: msg.text }];
    } else {
      parts = [{ text: String(msg) }];
    }

    return { role, parts };
  });
}

// Guardrail: check if any customer_ids were already contacted within the last 24 hours
async function applyContactFrequencyGuardrail(customerIds) {
  if (!customerIds || customerIds.length === 0) return { skippedIds: new Set(), count: 0 };

  const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const { data: recentMessages, error } = await supabase
    .from('campaign_messages')
    .select('customer_id')
    .in('customer_id', customerIds)
    .gte('updated_at', twentyFourHoursAgo)
    .neq('status', 'FAILED');

  if (error) {
    console.warn('[GUARDRAIL] Failed to query recent contacts, skipping guardrail:', error.message);
    return { skippedIds: new Set(), count: 0 };
  }

  const skippedIds = new Set((recentMessages || []).map(m => m.customer_id));
  return { skippedIds, count: skippedIds.size };
}

// Core helper function to handle database insertions and external gateway requests for campaign creation
async function executeCampaignCreation({ name, channel, message, filters, recipients }) {
  // 1. Save campaign draft in Supabase
  const { data: campaign, error: campError } = await supabase
    .from('campaigns')
    .insert([{ name, channel, message, status: 'PENDING' }])
    .select()
    .single();

  if (campError) throw campError;

  const campaignId = campaign.id;

  // 2. Resolve target list of recipients and pre-generate message IDs
  let resolvedRecipients = [];
  if (recipients && Array.isArray(recipients) && recipients.length > 0) {
    resolvedRecipients = recipients.map(r => ({
      customer_id: r.customer_id,
      phone: r.phone,
      name: r.name,
      message_id: r.message_id || crypto.randomUUID()
    }));
  } else {
    const customers = await getSegmentedCustomers(filters || {});
    resolvedRecipients = customers.map(c => ({
      customer_id: c.id,
      phone: c.phone,
      name: c.name,
      message_id: crypto.randomUUID()
    }));
  }

  // Apply 24-hour contact frequency guardrail
  const allCustomerIds = resolvedRecipients.map(r => r.customer_id);
  const guardrail = await applyContactFrequencyGuardrail(allCustomerIds);
  let guardrailSkipped = 0;

  if (guardrail.count > 0) {
    guardrailSkipped = guardrail.count;
    console.log(`GUARDRAIL: Skipped ${guardrailSkipped} customers — already contacted in last 24h`);
    resolvedRecipients = resolvedRecipients.filter(r => !guardrail.skippedIds.has(r.customer_id));
  }

  // Generate human-friendly guardrail message
  const guardrailMessage = guardrailSkipped === 1
    ? '💡 1 customer already heard from you today, so we gave them a little break. Your campaign reached everyone else!'
    : guardrailSkipped > 1
      ? `💡 ${guardrailSkipped} customers already heard from you today, so we gave them a little break. Your campaign reached everyone else!`
      : null;

  if (resolvedRecipients.length === 0) {
    return { ...campaign, guardrail_skipped: guardrailSkipped, guardrail_message: guardrailMessage };
  }

  // 3. Batch insert campaign messages with status 'SENT' and their pre-generated message_id
  const campaignMessages = resolvedRecipients.map(r => ({
    campaign_id: campaignId,
    customer_id: r.customer_id,
    message_id: r.message_id,
    status: 'SENT',
    updated_at: new Date().toISOString()
  }));

  const { error: msgInsertError } = await supabase
    .from('campaign_messages')
    .insert(campaignMessages);

  if (msgInsertError) throw msgInsertError;

  // 4. Send request to the channel-service simulation broker
  const channelServiceUrl = `${process.env.CHANNEL_SERVICE_URL || 'http://localhost:3002'}/send`;
  const sendResponse = await fetch(channelServiceUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      campaign_id: campaignId,
      recipients: resolvedRecipients,
      message,
      channel
    })
  });

  if (!sendResponse.ok) {
    const errText = await sendResponse.text();
    throw new Error(`Channel service request failed: ${errText}`);
  }

  // 5. Update overall campaign status to SENT and persist guardrail count
  const { data: updatedCampaign, error: campUpdateError } = await supabase
    .from('campaigns')
    .update({ status: 'SENT', guardrail_skipped: guardrailSkipped })
    .eq('id', campaignId)
    .select()
    .single();

  if (campUpdateError) throw campUpdateError;

  return {
    ...updatedCampaign,
    guardrail_skipped: guardrailSkipped,
    guardrail_message: guardrailMessage
  };
}

// Helper function to calculate campaign message delivery stats
async function getCampaignStats(campaignId) {
  const { data: messages, error } = await supabase
    .from('campaign_messages')
    .select('status')
    .eq('campaign_id', campaignId);

  if (error) {
    console.error(`Error calculating stats for campaign ${campaignId}:`, error);
    return { sent: 0, delivered: 0, failed: 0, opened: 0, guardrail_skipped: 0 };
  }

  const stats = { sent: 0, delivered: 0, failed: 0, opened: 0, guardrail_skipped: 0 };
  messages.forEach(msg => {
    if (msg.status === 'SENT') {
      stats.sent++;
    } else if (msg.status === 'DELIVERED') {
      stats.sent++;
      stats.delivered++;
    } else if (msg.status === 'OPENED') {
      stats.sent++;
      stats.delivered++;
      stats.opened++;
    } else if (msg.status === 'FAILED') {
      stats.failed++;
    }
  });

  // Look up campaign record for guardrail_skipped info
  const { data: campData } = await supabase
    .from('campaigns')
    .select('guardrail_skipped')
    .eq('id', campaignId)
    .single();

  if (campData && campData.guardrail_skipped) {
    stats.guardrail_skipped = campData.guardrail_skipped;
  }

  return stats;
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

/**
 * GET /api/customers
 * Lists all customers with order summary. Used by the AI for segment queries.
 */
app.get('/api/customers', async (req, res) => {
  try {
    const { data: customers, error } = await supabase
      .from('customers')
      .select('id, name, phone, email, tags, created_at, orders(id, amount, created_at)')
      .order('created_at', { ascending: false });

    if (error) throw error;

    // Enrich each customer with computed aggregates
    const enriched = (customers || []).map(c => {
      const orders = c.orders || [];
      const totalSpend = orders.reduce((sum, o) => sum + parseFloat(o.amount || 0), 0);
      const lastOrder = orders.length > 0
        ? new Date(Math.max(...orders.map(o => new Date(o.created_at)))).toISOString()
        : null;

      return {
        id: c.id,
        name: c.name,
        phone: c.phone,
        email: c.email,
        tags: c.tags,
        created_at: c.created_at,
        order_count: orders.length,
        total_spend: Math.round(totalSpend * 100) / 100,
        last_order_at: lastOrder
      };
    });

    res.json(enriched);
  } catch (err) {
    console.error('Error fetching customers:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/segments/preview
 * Dry-run a segment query. Accepts filter keys as query parameters.
 * Returns { count, sample: [first 5 customer names] }.
 */
app.get('/api/segments/preview', async (req, res) => {
  try {
    const filters = {};

    if (req.query.last_purchase_days_gt) filters.last_purchase_days_gt = Number(req.query.last_purchase_days_gt);
    if (req.query.last_purchase_days_lt) filters.last_purchase_days_lt = Number(req.query.last_purchase_days_lt);
    if (req.query.min_spend) filters.min_spend = Number(req.query.min_spend);
    if (req.query.max_spend) filters.max_spend = Number(req.query.max_spend);
    if (req.query.min_orders) filters.min_orders = Number(req.query.min_orders);
    if (req.query.tags_include) filters.tags_include = req.query.tags_include.split(',');
    if (req.query.tags_exclude) filters.tags_exclude = req.query.tags_exclude.split(',');

    const result = await previewSegment(filters);
    res.json(result);
  } catch (err) {
    console.error('Error previewing segment:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/chat
 * Primary conversation endpoint. Integrates Gemini co-pilot reasoning,
 * parses action tags, and triggers database segments or campaign dispatches.
 */
app.post('/api/chat', async (req, res) => {
  const { messages, context } = req.body;

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'Missing or invalid messages array' });
  }

  try {
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');
    
    let recentHistory = messages.slice(-10);
    if (messages.length > 0 && messages[0].role === 'system') {
      recentHistory = [messages[0], ...messages.slice(1).slice(-10)];
    }

    // 1. Find the latest AI action for PREVIEW_SEGMENT in the recent history
    let segmentFiltersToInject = null;
    for (let i = recentHistory.length - 1; i >= 0; i--) {
      const msg = recentHistory[i];
      if (msg.role === 'model' || msg.role === 'assistant') {
        const actionMatch = msg.content && msg.content.match(/<action>([\s\S]*?)<\/action>/);
        if (actionMatch) {
          try {
            const action = JSON.parse(actionMatch[1].trim());
            if (action.type === 'PREVIEW_SEGMENT') {
              segmentFiltersToInject = action.filters || {};
              if (action.limit) segmentFiltersToInject.limit = action.limit;
              if (action.sort_by) segmentFiltersToInject.sort_by = action.sort_by;
              break;
            }
          } catch (e) {
            // Ignore parse errors
          }
        }
      }
    }

    // 2. If we found segment filters, fetch real data and inject
    if (segmentFiltersToInject) {
      try {
        const result = await previewSegment(segmentFiltersToInject);
        const injectionMsg = {
          role: 'user',
          content: `SYSTEM: REAL SEGMENT DATA — count: ${result.count}, customers: [${result.sample.join(', ')}]. Use ONLY these names and this count in your response. Never invent customer names or counts.`
        };
        
        // Inject before the last user message
        const lastUserMessage = recentHistory.pop();
        recentHistory.push(injectionMsg);
        recentHistory.push(lastUserMessage);
      } catch (err) {
        console.error('Failed to inject real segment data:', err);
      }
    }

    const formattedContents = formatHistory(recentHistory);

    let aiText = '';
    let usedModel = 'gemini-1.5-flash';

    try {
      const model = genAI.getGenerativeModel({
        model: 'gemini-1.5-flash',
        systemInstruction: SYSTEM_PROMPT,
      });

      console.log(`[API Chat] Attempting model: ${usedModel}`);
      const response = await model.generateContent({
        contents: formattedContents,
        generationConfig: { temperature: 0.7 }
      });
      aiText = response.response.text();
    } catch (err) {
      if (err.status === 429 || (err.message && err.message.includes('429')) || (err.message && err.message.includes('Too Many Requests'))) {
        usedModel = 'gemini-2.0-flash';
        console.log(`[API Chat] 429 on primary model, retrying with fallback: ${usedModel}`);
        
        const fallbackModel = genAI.getGenerativeModel({
          model: 'gemini-2.0-flash',
          systemInstruction: SYSTEM_PROMPT,
        });

        const fallbackResponse = await fallbackModel.generateContent({
          contents: formattedContents,
          generationConfig: { temperature: 0.7 }
        });
        aiText = fallbackResponse.response.text();
      } else {
        throw err;
      }
    }

    console.log(`[AI Response] (Model: ${usedModel}):`, aiText);

    let actionResult = null;

    // Parse action tags: <action>{"type": ...}</action>
    const actionRegex = /<action>([\s\S]*?)<\/action>/;
    const match = aiText.match(actionRegex);

    if (match) {
      try {
        const action = JSON.parse(match[1].trim());
        console.log('[Parsed Action]:', action);

        const combinedFilters = action.filters || {};
        if (action.limit) combinedFilters.limit = action.limit;
        if (action.sort_by) combinedFilters.sort_by = action.sort_by;

        if (action.type === 'PREVIEW_SEGMENT') {
          const result = await previewSegment(combinedFilters);
          actionResult = {
            type: 'PREVIEW_SEGMENT',
            filters: combinedFilters,
            data: result
          };
        } else if (action.type === 'CREATE_CAMPAIGN') {
          const result = await executeCampaignCreation({
            name: action.name || `Campaign-${Date.now()}`,
            channel: action.channel || 'whatsapp',
            message: action.message,
            filters: combinedFilters
          });

          actionResult = {
            type: 'CREATE_CAMPAIGN',
            data: result
          };
        }
      } catch (err) {
        console.error('Failed to parse or execute action:', err);
        actionResult = {
          error: `Action execution failed: ${err.message}`
        };
      }
    }

    res.json({
      text: aiText,
      actionResult
    });

  } catch (err) {
    console.error('Error in /api/chat:', err);
    
    // Check for Gemini API rate limits (429 status)
    if (err.status === 429 || (err.message && err.message.includes('429')) || (err.message && err.message.includes('Too Many Requests'))) {
      return res.json({
        text: "⚠️ **Gemini API Rate Limit Exceeded (429)**: The AI copilot is receiving too many requests. Please wait a moment (about 1 minute) before sending your next message to allow the quota to reset.",
        actionResult: null
      });
    }
    
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/campaigns
 * Retrieves list of all campaigns alongside aggregated delivery and open stats.
 */
app.get('/api/campaigns', async (req, res) => {
  try {
    const { data: campaigns, error: campError } = await supabase
      .from('campaigns')
      .select('*')
      .order('created_at', { ascending: false });

    if (campError) throw campError;

    const { data: messages, error: msgError } = await supabase
      .from('campaign_messages')
      .select('campaign_id, status');

    if (msgError) throw msgError;

    // Aggregate stats by campaign_id in memory
    const statsMap = {};
    messages.forEach(msg => {
      const cid = msg.campaign_id;
      if (!statsMap[cid]) {
        statsMap[cid] = { sent: 0, delivered: 0, failed: 0, opened: 0 };
      }

      if (msg.status === 'SENT') {
        statsMap[cid].sent++;
      } else if (msg.status === 'DELIVERED') {
        statsMap[cid].sent++;
        statsMap[cid].delivered++;
      } else if (msg.status === 'OPENED') {
        statsMap[cid].sent++;
        statsMap[cid].delivered++;
        statsMap[cid].opened++;
      } else if (msg.status === 'FAILED') {
        statsMap[cid].failed++;
      }
    });

    const campaignsWithStats = campaigns.map(camp => ({
      ...camp,
      stats: statsMap[camp.id] || { sent: 0, delivered: 0, failed: 0, opened: 0 }
    }));

    res.json(campaignsWithStats);
  } catch (err) {
    console.error('Error fetching campaigns:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/campaigns/:id
 * Returns a single campaign's detail along with per-message delivery status breakdown.
 */
app.get('/api/campaigns/:id', async (req, res) => {
  const { id } = req.params;

  try {
    // Fetch the campaign record
    const { data: campaign, error: campError } = await supabase
      .from('campaigns')
      .select('*')
      .eq('id', id)
      .single();

    if (campError) throw campError;
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

    // Fetch all messages for this campaign with customer names
    const { data: messages, error: msgError } = await supabase
      .from('campaign_messages')
      .select('id, message_id, customer_id, status, updated_at, customers(name, phone, email)')
      .eq('campaign_id', id)
      .order('updated_at', { ascending: false });

    if (msgError) throw msgError;

    // Calculate aggregate stats
    const stats = { sent: 0, delivered: 0, failed: 0, opened: 0 };
    (messages || []).forEach(msg => {
      if (msg.status === 'SENT') {
        stats.sent++;
      } else if (msg.status === 'DELIVERED') {
        stats.sent++;
        stats.delivered++;
      } else if (msg.status === 'OPENED') {
        stats.sent++;
        stats.delivered++;
        stats.opened++;
      } else if (msg.status === 'FAILED') {
        stats.failed++;
      }
    });

    res.json({
      ...campaign,
      stats,
      messages: messages || []
    });
  } catch (err) {
    console.error('Error fetching campaign detail:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/campaigns/:id/inspector
 * Retrieves audit details for a campaign, returning customer order metrics,
 * formatted matching reason, and delivery status. Sorted by delivery outcome.
 */
app.get('/api/campaigns/:id/inspector', async (req, res) => {
  const { id } = req.params;

  try {
    const { data: messages, error } = await supabase
      .from('campaign_messages')
      .select(`
        status,
        customer_id,
        customers (
          name,
          orders (
            amount,
            created_at
          )
        )
      `)
      .eq('campaign_id', id);

    if (error) throw error;

    const now = new Date();

    const inspectorRows = (messages || []).map(row => {
      const customer = row.customers || {};
      const customerName = customer.name || 'Unknown Customer';
      const orders = customer.orders || [];
      const ordersCount = orders.length;

      const totalSpend = orders.reduce((sum, o) => sum + parseFloat(o.amount || 0), 0);

      let lastPurchaseDaysAgo = null;
      if (ordersCount > 0) {
        const dates = orders.map(o => new Date(o.created_at));
        const lastOrderDate = new Date(Math.max(...dates));
        lastPurchaseDaysAgo = Math.floor((now - lastOrderDate) / (1000 * 60 * 60 * 24));
      }

      // Generate a warm match reason in plain English
      const ordersWord = ordersCount === 1 ? 'order' : 'orders';
      const daysWord = lastPurchaseDaysAgo === 1 ? 'day' : 'days';
      const lastShoppedText = lastPurchaseDaysAgo !== null
        ? `last shopped ${lastPurchaseDaysAgo} ${daysWord} ago`
        : 'never shopped';
      const spendFormatted = `₹${Math.round(totalSpend).toLocaleString('en-IN')}`;
      const filterMatchReason = `${ordersCount} ${ordersWord} · ${lastShoppedText} · spent ${spendFormatted} total`;

      return {
        customer_name: customerName,
        status: row.status,
        orders_count: ordersCount,
        last_purchase_days_ago: lastPurchaseDaysAgo,
        total_spend: totalSpend,
        filter_match_reason: filterMatchReason
      };
    });

    // Sort by status: DELIVERED first, OPENED second, other status third, FAILED last
    const getStatusWeight = (status) => {
      const s = (status || '').toUpperCase();
      if (s === 'DELIVERED') return 1;
      if (s === 'OPENED') return 2;
      if (s === 'FAILED') return 4;
      return 3;
    };

    inspectorRows.sort((a, b) => getStatusWeight(a.status) - getStatusWeight(b.status));

    res.json(inspectorRows);
  } catch (err) {
    console.error('Error fetching campaign inspector data:', err);
    res.status(500).json({ error: err.message });
  }
});


/**
 * POST /api/campaigns
 * Directly creates and fires a campaign from JSON payload (alternative to chat agent).
 */
app.post('/api/campaigns', async (req, res) => {
  const { name, channel, message, filters, recipients } = req.body;

  if (!name || !channel || !message) {
    return res.status(400).json({ error: 'Missing required campaign fields: name, channel, message' });
  }

  try {
    const campaign = await executeCampaignCreation({ name, channel, message, filters, recipients });
    res.json(campaign);
  } catch (err) {
    console.error('Error dispatching campaign:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/receipts
 * Endpoint for callback deliveries from the channel service.
 * Updates message state and pushes real-time event updates to all SSE streams.
 */
app.post('/api/receipts', async (req, res) => {
  const { message_id, campaign_id, customer_id, status, timestamp } = req.body;
  console.log('[Receipt API] Incoming callback:', { message_id, campaign_id, status });

  if (!message_id || !campaign_id || !status) {
    console.warn('[Receipt API] Missing required fields in payload');
    return res.status(200).json({ error: 'Missing message_id, campaign_id or status fields (responding with 200 to prevent retry loops)' });
  }

  try {
    // 1. Update message status in DB
    const { error: updateError } = await supabase
      .from('campaign_messages')
      .update({ status, updated_at: timestamp || new Date().toISOString() })
      .eq('message_id', message_id);

    if (updateError) throw updateError;

    // Fetch the customer's name to emit in the SSE event stream log
    let customerName = 'Unknown Customer';
    if (customer_id) {
      const { data: custData } = await supabase
        .from('customers')
        .select('name')
        .eq('id', customer_id)
        .single();
      if (custData) {
        customerName = custData.name;
      }
    }

    const eventPayload = {
      customer_name: customerName,
      status,
      timestamp: timestamp || new Date().toISOString()
    };

    // 2. Recalculate stats for the campaign
    const updatedStats = await getCampaignStats(campaign_id);
    
    // 3. Emit real-time update to all active SSE client connections
    const clients = sseClients.get(campaign_id) || [];
    console.log(`[SSE Broadcast] Broadcasting event to ${clients.length} connected client(s) for campaign ${campaign_id}`);
    clients.forEach(clientRes => {
      console.log(`[SSE Broadcast] Sending payload to client:`, { status, customer_name: customerName });
      clientRes.write(`data: ${JSON.stringify({ campaign_id, stats: updatedStats, event: eventPayload })}\n\n`);
    });
  } catch (err) {
    console.error('[Receipt API Error] Error handling receipt (returning 200 to prevent loops):', err.message);
  }

  // Always respond with 200 OK
  return res.status(200).json({ success: true });
});

/**
 * GET /api/stream/:campaign_id
 * Server-Sent Events (SSE) stream endpoint. Exposes a continuous stream
 * delivering live campaign stats ticks.
 */
app.get('/api/stream/:campaign_id', async (req, res) => {
  const { campaign_id } = req.params;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Register client
  if (!sseClients.has(campaign_id)) {
    sseClients.set(campaign_id, []);
  }
  sseClients.get(campaign_id).push(res);

  console.log(`[SSE Connected] Client registered for campaign: ${campaign_id}`);

  try {
    // Fetch initial stats and last 10 historical events
    const initialStats = await getCampaignStats(campaign_id);
    
    const { data: recentMessages } = await supabase
      .from('campaign_messages')
      .select('status, updated_at, customers(name)')
      .eq('campaign_id', campaign_id)
      .order('updated_at', { ascending: false })
      .limit(10);

    const initialEvents = (recentMessages || [])
      .map(m => ({
        customer_name: m.customers?.name || 'Unknown Customer',
        status: m.status,
        timestamp: m.updated_at
      }))
      .reverse(); // Display oldest first in the log

    res.write(`data: ${JSON.stringify({ campaign_id, stats: initialStats, events: initialEvents })}\n\n`);
  } catch (err) {
    console.error('Error fetching initial stream logs:', err);
    // Fallback if db query fails
    const initialStats = await getCampaignStats(campaign_id);
    res.write(`data: ${JSON.stringify({ campaign_id, stats: initialStats, events: [] })}\n\n`);
  }

  // Remove client connection on close
  req.on('close', () => {
    console.log(`[SSE Disconnected] Client closed connection for campaign: ${campaign_id}`);
    const clients = sseClients.get(campaign_id) || [];
    const index = clients.indexOf(res);
    if (index !== -1) {
      clients.splice(index, 1);
    }
    if (clients.length === 0) {
      sseClients.delete(campaign_id);
    }
  });
});

app.listen(PORT, () => {
  console.log(`CRM API server running on port ${PORT}`);
});
