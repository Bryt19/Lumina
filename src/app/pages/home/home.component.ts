import { Component, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { CountUpDirective } from '../../directives/count-up.directive';

interface Faq {
  q: string;
  a: string;
}

@Component({
  selector: 'app-home',
  standalone: true,
  imports: [CommonModule, CountUpDirective],
  templateUrl: './home.component.html',
})
export class HomeComponent {
  samplePrompts = [
    'Where is my order?',
    'Request a refund',
    'What is your refund policy?',
    'Escalate to a human agent',
  ];

  trustedBy = [
    'Northwind',
    'Acme Retail',
    'BlueSky Labs',
    'Orbit Goods',
    'Vertex Co.',
    'Summit Outfitters',
    'Nimbus Tech',
    'Helios Health',
    'BrightPath',
    'Fern & Co.',
  ];

  faqs: Faq[] = [
    {
      q: 'How does the agent access my order data?',
      a: 'Every query is scoped to the authenticated customer. The agent runs real tools against your orders, tickets, and policy database — it can only ever see the records the signed-in customer is allowed to see.',
    },
    {
      q: 'What happens when the agent can’t answer?',
      a: 'The agent escalates. It opens a high-priority ticket with the full conversation context, and a human support agent picks it up — nothing is lost or left unanswered.',
    },
    {
      q: 'How do refunds work?',
      a: 'Refunds are never issued blindly. The agent explains the applicable terms, gets your explicit confirmation in the chat, and only then opens the refund request.',
    },
    {
      q: 'Is my customer data safe?',
      a: 'Yes. The AI key and tools live on the server, sessions are authenticated, and every data tool is scoped to the caller. There is no API key in the browser and no cross-customer access.',
    },
    {
      q: 'How long does setup take?',
      a: 'Most teams are up in a day: connect your order and ticket data, upload your policy documents, and the agent is ready to answer — no training data or ML expertise required.',
    },
    {
      q: 'Can I try it before buying?',
      a: 'Absolutely. Open the chat and sign in with a demo account to try order lookups, refunds, and escalations — no signup or credit card needed.',
    },
  ];

  openFaq = signal<number | null>(0);

  toggleFaq(index: number) {
    this.openFaq.update((current) => (current === index ? null : index));
  }

  openChat(prompt?: string) {
    window.dispatchEvent(
      new CustomEvent('acsap:open-chat', { detail: { prompt } })
    );
  }
}
