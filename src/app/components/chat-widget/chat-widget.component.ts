import { Component, OnDestroy, OnInit, inject, signal } from '@angular/core';
import { CommonModule, DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ChatService, DemoAccount } from '../../services/chat.service';

interface ChatMessage {
  sender: 'user' | 'agent';
  text: string;
  timestamp: Date;
}

const GREETING =
  'Hello! I am your support assistant. Ask about your orders, tickets, refunds, or policies.';

const OPEN_CHAT_EVENT = 'acsap:open-chat';

@Component({
  selector: 'app-chat-widget',
  standalone: true,
  imports: [CommonModule, FormsModule, DatePipe],
  templateUrl: './chat-widget.component.html',
})
export class ChatWidgetComponent implements OnInit, OnDestroy {
  private chat = inject(ChatService);

  messages = signal<ChatMessage[]>([]);
  newMessage = signal('');
  isLoading = signal(false);
  demoAccounts = signal<DemoAccount[]>([]);
  loginError = signal('');
  toolActivity = signal('');
  isOpen = signal(false);

  customer = this.chat.customer;

  actionChips = [
    'Where is my order?',
    'What is your refund policy?',
    'Request a refund',
    'Escalate to a human agent',
  ];

  private onOpenChatRequest = (event: Event) => {
    this.open();
    const prompt = (event as CustomEvent).detail?.prompt;
    if (typeof prompt === 'string' && prompt.trim()) {
      this.newMessage.set(prompt.trim());
    }
  };

  ngOnInit() {
    if (this.chat.isAuthenticated) {
      this.messages.set([{ sender: 'agent', text: GREETING, timestamp: new Date() }]);
    }
    window.addEventListener(OPEN_CHAT_EVENT, this.onOpenChatRequest);
  }

  ngOnDestroy() {
    window.removeEventListener(OPEN_CHAT_EVENT, this.onOpenChatRequest);
  }

  open() {
    this.isOpen.set(true);
    if (!this.chat.isAuthenticated && !this.demoAccounts().length && !this.loginError()) {
      this.loadAccounts();
    }
  }

  close() {
    this.isOpen.set(false);
  }

  async login(account: DemoAccount) {
    this.loginError.set('');
    try {
      await this.chat.login(account.id);
      this.messages.set([{ sender: 'agent', text: GREETING, timestamp: new Date() }]);
    } catch (err) {
      this.loginError.set((err as Error).message);
    }
  }

  logout() {
    this.chat.logout();
    this.messages.set([]);
    this.toolActivity.set('');
  }

  async sendMessage(text?: string) {
    const messageText = (text ?? this.newMessage()).trim();
    if (!messageText) return;

    this.messages.update((msgs) => [
      ...msgs,
      { sender: 'user', text: messageText, timestamp: new Date() },
    ]);
    this.newMessage.set('');
    this.isLoading.set(true);
    this.toolActivity.set('');

    // Placeholder bubble that deltas stream into.
    this.messages.update((msgs) => [
      ...msgs,
      { sender: 'agent', text: '', timestamp: new Date() },
    ]);

    try {
      let accumulated = '';
      const finalText = await this.chat.sendMessage(
        messageText,
        (delta) => {
          accumulated += delta;
          this.updateLastAgentMessage(accumulated);
        },
        (toolName) => this.toolActivity.set(toolName)
      );
      this.updateLastAgentMessage(finalText);
    } catch (error) {
      this.updateLastAgentMessage(
        `Sorry, I encountered an error: ${(error as Error).message}`
      );
    } finally {
      this.isLoading.set(false);
      this.toolActivity.set('');
    }
  }

  private async loadAccounts() {
    try {
      this.demoAccounts.set(await this.chat.listDemoAccounts());
    } catch (err) {
      this.loginError.set((err as Error).message);
    }
  }

  private updateLastAgentMessage(text: string) {
    this.messages.update((msgs) => {
      const copy = [...msgs];
      const last = copy[copy.length - 1];
      if (last && last.sender === 'agent') {
        copy[copy.length - 1] = { ...last, text };
      }
      return copy;
    });
  }
}
