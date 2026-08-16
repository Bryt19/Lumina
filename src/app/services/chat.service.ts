import { Injectable, signal } from '@angular/core';

export interface Customer {
  id: string;
  name: string;
  email: string;
}

export interface DemoAccount {
  id: string;
  name: string;
  email: string;
}

const SESSION_KEY = 'acsap.session';

@Injectable({
  providedIn: 'root',
})
export class ChatService {
  readonly customer = signal<Customer | null>(null);
  conversationId: string | null = null;

  private token: string | null = null;

  constructor() {
    this.restoreSession();
  }

  get isAuthenticated(): boolean {
    return this.customer() !== null;
  }

  async listDemoAccounts(): Promise<DemoAccount[]> {
    const res = await fetch('/api/auth/customers');
    if (!res.ok) throw new Error('Could not load demo accounts.');
    const data = await res.json();
    return data.customers ?? [];
  }

  async login(customerId: string): Promise<Customer> {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ customerId }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || 'Login failed.');
    this.token = data.token;
    this.customer.set(data.customer);
    this.conversationId = null;
    this.persistSession();
    return data.customer;
  }

  logout(): void {
    this.token = null;
    this.customer.set(null);
    this.conversationId = null;
    localStorage.removeItem(SESSION_KEY);
  }

  resetConversation(): void {
    this.conversationId = null;
    this.persistSession();
  }

  /** Permanently deletes the current conversation on the server, then resets locally. */
  async clearConversation(): Promise<void> {
    let error: Error | null = null;
    if (this.conversationId) {
      try {
        const res = await fetch(`/api/conversations/${this.conversationId}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${this.token}` },
        });
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          error = new Error(body?.message || 'Could not clear the conversation.');
        }
      } catch (e) {
        error = e instanceof Error ? e : new Error('Could not clear the conversation.');
      }
    }
    // Always start fresh locally — even if the server delete failed, the next
    // message should open a brand-new conversation, not resume the old one.
    this.resetConversation();
    if (error) throw error;
  }

  /**
   * Sends a message and streams the assistant reply through onDelta
   * (and tool activity through onTool). Resolves with the final text.
   */
  async sendMessage(
    text: string,
    onDelta: (delta: string) => void,
    onTool?: (toolName: string) => void,
    regenerate = false
  ): Promise<string> {
    if (!this.token) throw new Error('Not authenticated.');

    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.token}`,
      },
      body: JSON.stringify({ message: text, conversationId: this.conversationId, regenerate }),
    });

    if (!res.ok || !res.body) {
      let message = 'The support server is unavailable.';
      try {
        const body = await res.json();
        if (body?.message) message = body.message;
      } catch {
        /* keep default */
      }
      throw new Error(message);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let finalText = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const events = buffer.split('\n\n');
      buffer = events.pop() ?? '';
      for (const event of events) {
        const dataLines = event
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trim());
        if (dataLines.length === 0) continue;

        const data = JSON.parse(dataLines.join('\n'));
        if (typeof data.delta === 'string') {
          finalText += data.delta;
          onDelta(data.delta);
        }
        if (data.tool) onTool?.(data.tool);
        if (data.error) throw new Error(data.error);
        if (data.done !== undefined) {
          this.conversationId = data.conversationId;
          this.persistSession();
          return data.text ?? finalText;
        }
      }
    }
    return finalText;
  }

  private restoreSession(): void {
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw);
      if (saved?.token && saved?.customer) {
        this.token = saved.token;
        this.customer.set(saved.customer);
        this.conversationId = saved.conversationId ?? null;
      }
    } catch {
      localStorage.removeItem(SESSION_KEY);
    }
  }

  private persistSession(): void {
    if (this.token && this.customer()) {
      localStorage.setItem(
        SESSION_KEY,
        JSON.stringify({
          token: this.token,
          customer: this.customer(),
          conversationId: this.conversationId,
        })
      );
    }
  }
}
