import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { provideRouter } from '@angular/router';
import { AppComponent } from './app.component';
import { ChatService } from './services/chat.service';

describe('AppComponent', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [AppComponent],
      providers: [
        provideRouter([]),
        {
          provide: ChatService,
          useValue: {
            customer: signal(null),
            isAuthenticated: false,
            listDemoAccounts: () => Promise.resolve([]),
            login: () => Promise.resolve({ id: 'x', name: 'X', email: 'x@x' }),
            logout: () => {},
            sendMessage: () => Promise.resolve('ok'),
          },
        },
      ],
    }).compileComponents();
  });

  it('should create the app', () => {
    const fixture = TestBed.createComponent(AppComponent);
    const app = fixture.componentInstance;
    expect(app).toBeTruthy();
  });

  it('should render the site navigation', () => {
    const fixture = TestBed.createComponent(AppComponent);
    fixture.detectChanges();
    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.querySelector('nav')).toBeTruthy();
    expect(compiled.textContent).toContain('Lumina Support');
    expect(compiled.textContent).toContain('Features');
    expect(compiled.textContent).toContain('Chat now');
  });
});
