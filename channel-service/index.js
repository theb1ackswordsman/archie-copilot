import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import crypto from 'crypto';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3002;

const corsOptions = {
  origin: process.env.FRONTEND_URL ? [process.env.FRONTEND_URL, 'http://localhost:5173'] : '*'
};
app.use(cors(corsOptions));

app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

/**
 * Retries sending callbacks to the CRM API with exponential backoff.
 * Retries up to 3 times on network failure or 5xx status codes.
 */
async function sendCallbackWithRetry(payload, attempt = 1) {
  const crmUrl = `${process.env.CRM_API_URL || 'http://localhost:3001'}/api/receipts`;
  console.log(`[Callback ATTEMPT] Sending POST to ${crmUrl} for msg ${payload.message_id} with status ${payload.status} (attempt ${attempt}/4)`);
  
  try {
    const response = await fetch(crmUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (response.status >= 500) {
      throw new Error(`Server returned 5xx status: ${response.status}`);
    }
    
    console.log(`[Callback OK] Msg ${payload.message_id} -> ${payload.status}`);
  } catch (err) {
    console.error(`[Callback ERROR] Msg ${payload.message_id} (Attempt ${attempt}/4): ${err.message}`);
    
    if (attempt <= 3) {
      const delay = Math.pow(2, attempt - 1) * 1000; // 1s, 2s, 4s
      console.log(`[Callback Retry] Scheduling retry in ${delay}ms for Msg ${payload.message_id}`);
      setTimeout(() => {
        sendCallbackWithRetry(payload, attempt + 1);
      }, delay);
    } else {
      console.error(`[Callback FAILED] Msg ${payload.message_id} abandoned after 3 retries.`);
    }
  }
}

/**
 * POST /send
 * Accepts: { campaign_id, recipients: [{customer_id, phone, name}], message, channel }
 * Immediately generates UUIDs and returns 202.
 * Triggers async delivery simulation after response is dispatched.
 */
app.post('/send', (req, res) => {
  const { campaign_id, recipients, message, channel } = req.body;

  if (!campaign_id || !recipients || !Array.isArray(recipients)) {
    return res.status(400).json({ error: 'Missing campaign_id or recipients list' });
  }

  console.log(`[Send Request] Campaign ${campaign_id} | Channel: ${channel} | Recipients: ${recipients.length}`);

  // 1. Immediately map and generate message IDs
  const messagesList = recipients.map(recipient => ({
    customer_id: recipient.customer_id,
    message_id: recipient.message_id || crypto.randomUUID(),
    phone: recipient.phone,
    name: recipient.name
  }));

  // 2. Return 202 Accepted immediately
  res.status(202).json({
    success: true,
    message: 'Campaign send request accepted',
    messages: messagesList.map(m => ({ customer_id: m.customer_id, message_id: m.message_id }))
  });

  // 3. Process simulations asynchronously
  messagesList.forEach(item => {
    const { customer_id, message_id } = item;
    
    // Simulate delivery latency: random 500ms to 3s
    const deliveryDelay = Math.random() * (3000 - 500) + 500;
    
    setTimeout(() => {
      // Determine delivery outcome
      // 90% Delivered, 8% Failed, 2% Unknown
      const rand = Math.random();
      let status;
      if (rand < 0.90) {
        status = 'DELIVERED';
      } else if (rand < 0.98) {
        status = 'FAILED';
      } else {
        status = 'UNKNOWN';
      }

      console.log(`[setTimeout Fire] Delivery simulation fired for msg ${message_id} after ${Math.round(deliveryDelay)}ms with status: ${status}`);

      const deliveryPayload = {
        message_id,
        campaign_id,
        customer_id,
        status,
        timestamp: new Date().toISOString()
      };

      // Fire delivery callback
      sendCallbackWithRetry(deliveryPayload);

      // If delivered successfully, simulate user open behavior
      if (status === 'DELIVERED') {
        const openedRand = Math.random();
        
        // 30% chance the recipient opens the message
        if (openedRand < 0.30) {
          // Open latency: random 1s to 4s after delivery
          const openDelay = Math.random() * (4000 - 1000) + 1000;
          
          setTimeout(() => {
            console.log(`[setTimeout Fire] Open simulation fired for msg ${message_id} after ${Math.round(openDelay)}ms`);
            const openPayload = {
              message_id,
              campaign_id,
              customer_id,
              status: 'OPENED',
              timestamp: new Date().toISOString()
            };
            
            // Fire open event callback
            sendCallbackWithRetry(openPayload);
          }, openDelay);
        }
      }
    }, deliveryDelay);
  });
});

app.listen(PORT, () => {
  console.log(`Channel Service server running on port ${PORT}`);
});
