import { Component, inject, signal } from '@angular/core';
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
export class AppComponent {
  private chat = inject(ChatService);

  isDarkMode = signal(false);

  customer = this.chat.customer;

  constructor() {
    this.isDarkMode.set(document.body.classList.contains('dark'));
  }

  toggleTheme() {
    const newTheme = this.isDarkMode() ? 'light' : 'dark';
    document.body.className = newTheme;
    this.isDarkMode.set(newTheme === 'dark');
  }

  openChat() {
    window.dispatchEvent(new CustomEvent('acsap:open-chat'));
  }
}
