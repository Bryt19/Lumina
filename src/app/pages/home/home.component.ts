import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';

@Component({
  selector: 'app-home',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './home.component.html',
})
export class HomeComponent {
  samplePrompts = [
    'Where is my order?',
    'Request a refund',
    'What is your refund policy?',
    'Escalate to a human agent',
  ];

  openChat(prompt?: string) {
    window.dispatchEvent(
      new CustomEvent('acsap:open-chat', { detail: { prompt } })
    );
  }
}
