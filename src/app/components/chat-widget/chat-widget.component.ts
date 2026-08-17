import { Component, ElementRef, OnDestroy, OnInit, inject, signal } from '@angular/core';
import { CommonModule, DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ChatService, DemoAccount } from '../../services/chat.service';

interface ChatMessage {
  sender: 'user' | 'agent';
  text: string;
  timestamp: Date;
}

const GREETING =
  'Hello! I am Lumina, your AI support assistant. Ask about your orders, tickets, refunds, or policies.';

const OPEN_CHAT_EVENT = 'acsap:open-chat';

@Component({
  selector: 'app-chat-widget',
  standalone: true,
  imports: [CommonModule, FormsModule, DatePipe],
  templateUrl: './chat-widget.component.html',
})
export class ChatWidgetComponent implements OnInit, OnDestroy {
  private chat = inject(ChatService);
  private host = inject(ElementRef<HTMLElement>);

  messages = signal<ChatMessage[]>([]);
  newMessage = signal('');
  isLoading = signal(false);
  demoAccounts = signal<DemoAccount[]>([]);
  loginError = signal('');
  toolActivity = signal('');
  isOpen = signal(false);
  copiedIndex = signal<number | null>(null);
  confirmClear = signal(false);

  private lastUserPrompt = '';
  private copyTimer: ReturnType<typeof setTimeout> | null = null;
  private savedScrollStyles: {
    htmlOverflow: string;
    bodyOverflow: string;
    bodyPaddingRight: string;
  } | null = null;

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
    window.addEventListener('wheel', this.onPageWheel, { passive: false });
    window.addEventListener('touchmove', this.onPageTouchMove, { passive: false });
    window.addEventListener('resize', this.onWindowResize);
  }

  ngOnDestroy() {
    window.removeEventListener(OPEN_CHAT_EVENT, this.onOpenChatRequest);
    if (this.copyTimer) clearTimeout(this.copyTimer);
    window.removeEventListener('wheel', this.onPageWheel);
    window.removeEventListener('touchmove', this.onPageTouchMove);
    window.removeEventListener('resize', this.onWindowResize);
    this.setBodyScrollLock(false);
  }

  /** Re-evaluates the scroll lock when the viewport crosses the mobile breakpoint. */
  private onWindowResize = () => {
    if (this.isOpen()) {
      this.setBodyScrollLock(this.isMobileViewport());
    }
  };

  /** Matches Tailwind's `sm:` breakpoint — below it the chat is a full-screen mobile drawer. */
  private isMobileViewport(): boolean {
    return window.innerWidth < 640;
  }

  open() {
    this.isOpen.set(true);
    if (this.isMobileViewport()) {
      this.setBodyScrollLock(true);
    }
    if (!this.chat.isAuthenticated && !this.demoAccounts().length && !this.loginError()) {
      this.loadAccounts();
    }
  }

  close() {
    this.isOpen.set(false);
    this.setBodyScrollLock(false);
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
    this.confirmClear.set(false);
  }

  /** Permanently clears the current conversation and returns to the welcome state. */
  async clearConversation() {
    if (this.isLoading()) return;
    try {
      await this.chat.clearConversation();
    } catch {
      /* Server unreachable — the local reset below still gives a clean slate. */
    }
    this.messages.set([{ sender: 'agent', text: GREETING, timestamp: new Date() }]);
    this.lastUserPrompt = '';
    this.toolActivity.set('');
    this.copiedIndex.set(null);
    this.confirmClear.set(false);
  }

  async sendMessage(text?: string) {
    const messageText = (text ?? this.newMessage()).trim();
    if (!messageText || this.isLoading()) return;

    this.lastUserPrompt = messageText;
    this.messages.update((msgs) => [
      ...msgs,
      { sender: 'user', text: messageText, timestamp: new Date() },
    ]);
    this.newMessage.set('');
    await this.streamReply(messageText);
  }

  /** Re-answers the last question, replacing the previous agent reply. */
  async regenerate() {
    if (this.isLoading() || !this.lastUserPrompt) return;
    // Drop the trailing agent reply (usually one) before streaming a new one.
    this.messages.update((msgs) => {
      const copy = [...msgs];
      while (copy.length && copy[copy.length - 1].sender === 'agent') copy.pop();
      return copy;
    });
    await this.streamReply(this.lastUserPrompt, true);
  }

  async copyMessage(index: number, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      this.copiedIndex.set(index);
      if (this.copyTimer) clearTimeout(this.copyTimer);
      this.copyTimer = setTimeout(() => this.copiedIndex.set(null), 1500);
    } catch {
      /* clipboard unavailable — ignore */
    }
  }

  /** Streams an agent reply into a fresh placeholder bubble. */
  private async streamReply(prompt: string, regenerate = false) {
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
        prompt,
        (delta) => {
          accumulated += delta;
          this.updateLastAgentMessage(accumulated);
        },
        (toolName) => this.toolActivity.set(toolName),
        regenerate
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

  /**
   * Locks/unlocks the page scroll while the chat widget is open (mobile only).
   * Hides overflow on both <html> and <body> (robust across browsers) and
   * pads the body by the scrollbar width so layouts don't jump when the
   * scrollbar disappears.
   */
  private setBodyScrollLock(lock: boolean) {
    const html = document.documentElement;
    const body = document.body;
    if (lock) {
      if (!this.savedScrollStyles) {
        this.savedScrollStyles = {
          htmlOverflow: html.style.overflow,
          bodyOverflow: body.style.overflow,
          bodyPaddingRight: body.style.paddingRight,
        };
        const scrollbarWidth = window.innerWidth - html.clientWidth;
        body.style.paddingRight = `${scrollbarWidth}px`;
      }
      html.style.overflow = 'hidden';
      body.style.overflow = 'hidden';
    } else if (this.savedScrollStyles) {
      html.style.overflow = this.savedScrollStyles.htmlOverflow;
      body.style.overflow = this.savedScrollStyles.bodyOverflow;
      body.style.paddingRight = this.savedScrollStyles.bodyPaddingRight;
      this.savedScrollStyles = null;
    }
  }

  /**
   * Browser-agnostic scroll guard (mobile only): while the chat is open,
   * swallow wheel and touch scrolling aimed at the page behind the widget
   * (events inside the widget, e.g. the message feed, keep scrolling normally).
   */
  private onPageWheel = (event: WheelEvent) => {
    if (
      this.isOpen() &&
      this.isMobileViewport() &&
      !this.host.nativeElement.contains(event.target as Node)
    ) {
      event.preventDefault();
    }
  };

  private onPageTouchMove = (event: TouchEvent) => {
    if (
      this.isOpen() &&
      this.isMobileViewport() &&
      !this.host.nativeElement.contains(event.target as Node)
    ) {
      event.preventDefault();
    }
  };
}
