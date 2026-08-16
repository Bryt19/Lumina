import { Component, OnDestroy, OnInit, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { ChatWidgetComponent } from './components/chat-widget/chat-widget.component';
import { ChatService } from './services/chat.service';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, RouterOutlet, RouterLink, RouterLinkActive, ChatWidgetComponent],
  templateUrl: './app.component.html',
})
export class AppComponent implements OnInit, OnDestroy {
  private chat = inject(ChatService);

  isDarkMode = signal(false);
  showScrollTop = signal(false);

  customer = this.chat.customer;

  private readonly THEME_KEY = 'lumina-theme';

  private onScroll = () => {
    this.showScrollTop.set(window.scrollY > 400);
  };

  constructor() {
    const stored = localStorage.getItem(this.THEME_KEY);
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const dark = stored ? stored === 'dark' : prefersDark;
    document.body.classList.toggle('dark', dark);
    this.isDarkMode.set(dark);
  }

  ngOnInit() {
    window.addEventListener('scroll', this.onScroll, { passive: true });
    this.onScroll();
  }

  ngOnDestroy() {
    window.removeEventListener('scroll', this.onScroll);
  }

  toggleTheme() {
    const newTheme = this.isDarkMode() ? 'light' : 'dark';
    document.body.className = newTheme;
    localStorage.setItem(this.THEME_KEY, newTheme);
    this.isDarkMode.set(newTheme === 'dark');
  }

  openChat(prompt?: string) {
    window.dispatchEvent(
      new CustomEvent('acsap:open-chat', { detail: { prompt } })
    );
  }

  scrollToTop() {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
}
