import { Type } from '@google/genai';
import {
  findOrderForCustomer,
  getOrdersForCustomer,
  findTicketForCustomer,
  getTicketsForCustomer,
  updateOrderStatus,
  createTicket,
} from '../db.js';

const POLICY_KB = {
  shipping:
    'Standard shipping takes 3-5 business days. Expedited (2-day) shipping is available for $12.99. ' +
    'Orders leave the warehouse within 1 business day of payment confirmation.',
  refund:
    'Refunds are issued to the original payment method within 5-10 business days of the refund being approved. ' +
    'Refund requests must reference the order ID and can only be submitted for orders that are not yet delivered ' +
    'or were delivered within the last 30 days.',
  returns:
    'Items can be returned within 30 days of delivery, in original condition with all accessories and packaging. ' +
    'Return shipping is free for defective items.',
  warranty:
    'All electronics carry a 12-month limited warranty covering manufacturing defects. ' +
    'Warranty claims are handled through a support ticket.',
};

function orderToReply(order) {
  if (!order) return null;
  return {
    orderId: order.id,
    item: order.item,
    status: order.status,
    expectedDelivery: order.eta || null,
    total: order.total,
  };
}

export const toolRegistry = [
  {
    declaration: {
      name: 'listMyOrders',
      description:
        'Lists all orders belonging to the current customer, including status and expected delivery.',
      parameters: { type: Type.OBJECT, properties: {} },
    },
    async execute(_args, ctx) {
      const orders = getOrdersForCustomer(ctx.customerId).map(orderToReply);
      return orders.length ? { orders } : { orders: [], message: 'No orders found for this account.' };
    },
  },

  {
    declaration: {
      name: 'lookupOrderStatus',
      description:
        'Looks up the status of an order using its order ID. Only returns data for the current customer\'s own orders.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          orderId: { type: Type.STRING, description: 'The ID of the order to look up.' },
        },
        required: ['orderId'],
      },
    },
    async execute(args, ctx) {
      const order = findOrderForCustomer(args.orderId, ctx.customerId);
      if (!order) {
        return {
          error: 'order_not_found',
          message: `No order with ID ${args.orderId} was found for this account.`,
        };
      }
      return orderToReply(order);
    },
  },

  {
    declaration: {
      name: 'lookupTicketStatus',
      description:
        'Looks up the status of a support ticket using its ticket ID. Only returns data for the current customer\'s own tickets.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          ticketId: { type: Type.STRING, description: 'The ID of the ticket to look up.' },
        },
        required: ['ticketId'],
      },
    },
    async execute(args, ctx) {
      const ticket = findTicketForCustomer(args.ticketId, ctx.customerId);
      if (!ticket) {
        return {
          error: 'ticket_not_found',
          message: `No ticket with ID ${args.ticketId} was found for this account.`,
        };
      }
      return { ticketId: ticket.id, subject: ticket.subject, status: ticket.status, priority: ticket.priority };
    },
  },

  {
    declaration: {
      name: 'listMyTickets',
      description: 'Lists all support tickets belonging to the current customer.',
      parameters: { type: Type.OBJECT, properties: {} },
    },
    async execute(_args, ctx) {
      const tickets = getTicketsForCustomer(ctx.customerId).map((t) => ({
        ticketId: t.id,
        subject: t.subject,
        status: t.status,
        priority: t.priority,
      }));
      return tickets.length ? { tickets } : { tickets: [], message: 'No open tickets for this account.' };
    },
  },

  {
    declaration: {
      name: 'requestRefund',
      description:
        'Requests a refund for an order. Requires the customer to explicitly confirm before the refund is submitted. ' +
        'Call this twice: first without confirmation to describe the refund terms, then again with confirmed=true once the customer agrees.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          orderId: { type: Type.STRING, description: 'The ID of the order to refund.' },
          confirmed: {
            type: Type.BOOLEAN,
            description: 'Whether the customer has explicitly confirmed the refund request.',
          },
        },
        required: ['orderId', 'confirmed'],
      },
    },
    async execute(args, ctx) {
      const order = findOrderForCustomer(args.orderId, ctx.customerId);
      if (!order) {
        return {
          error: 'order_not_found',
          message: `No order with ID ${args.orderId} was found for this account.`,
        };
      }
      if (order.status === 'delivered') {
        return {
          error: 'refund_not_eligible',
          message:
            'This order was already delivered. Delivered orders cannot be refunded automatically; ' +
            'we can escalate a return request to a human agent instead.',
        };
      }
      if (order.status === 'refund_requested') {
        return { status: 'already_requested', message: `A refund for ${order.id} was already requested.` };
      }
      if (!args.confirmed) {
        return {
          status: 'needs_confirmation',
          message:
            `A refund for ${order.id} (${order.item}, $${order.total.toFixed(2)}) will be issued to the original ` +
            'payment method within 5-10 business days after approval. Reply confirming to proceed.',
        };
      }
      updateOrderStatus(order.id, 'refund_requested');
      createTicket(ctx.customerId, `Refund request for ${order.id}`, 'open', 'high');
      return {
        status: 'refund_submitted',
        message: `Refund request for ${order.id} was submitted. Refund will be issued to the original payment method within 5-10 business days.`,
      };
    },
  },

  {
    declaration: {
      name: 'escalateToHuman',
      description:
        'Escalates the current issue to a human support agent by creating a high-priority ticket.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          subject: { type: Type.STRING, description: 'Short summary of the issue to escalate.' },
          reason: { type: Type.STRING, description: 'Why the customer needs a human agent.' },
        },
        required: ['subject', 'reason'],
      },
    },
    async execute(args, ctx) {
      const ticket = createTicket(ctx.customerId, args.subject, 'escalated', 'high');
      console.log(`[escalation] ${ctx.customer.name} -> ticket ${ticket.id}: ${args.subject}`);
      return {
        ticketId: ticket.id,
        message:
          `I\'ve escalated this to a human agent (ticket ${ticket.id}). A support representative will follow up ` +
          'by email within 2 business hours.',
      };
    },
  },

  {
    declaration: {
      name: 'getPolicy',
      description:
        'Returns the current policy text for a given topic. Valid topics: shipping, refund, returns, warranty.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          topic: { type: Type.STRING, description: 'The policy topic to retrieve.' },
        },
        required: ['topic'],
      },
    },
    async execute(args, ctx) {
      const text = POLICY_KB[args.topic];
      if (!text) {
        return {
          error: 'unknown_topic',
          message: `No policy found for "${args.topic}". Valid topics: ${Object.keys(POLICY_KB).join(', ')}.`,
        };
      }
      return { topic: args.topic, policy: text };
    },
  },
];

export function executeTool(name, args, ctx) {
  const tool = toolRegistry.find((t) => t.declaration.name === name);
  if (!tool) {
    return Promise.resolve({ error: 'unknown_tool', message: `Unknown tool "${name}".` });
  }
  return tool.execute(args ?? {}, ctx);
}
