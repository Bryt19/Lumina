import { Directive, ElementRef, Input, OnDestroy, OnInit } from '@angular/core';

@Directive({
  selector: '[appCountUp]',
  standalone: true,
})
export class CountUpDirective implements OnInit, OnDestroy {
  @Input() appCountUp: number | null = null;
  @Input() decimals = 0;
  @Input() prefix = '';
  @Input() suffix = '';
  @Input() duration = 1600;

  private observer?: IntersectionObserver;
  private frame?: number;

  constructor(private el: ElementRef<HTMLElement>) {}

  ngOnInit() {
    if (!('IntersectionObserver' in window)) {
      this.setValue(this.appCountUp ?? 0);
      return;
    }
    this.observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          this.animate();
          this.observer?.disconnect();
        }
      },
      { threshold: 0.4 }
    );
    this.observer.observe(this.el.nativeElement);
  }

  ngOnDestroy() {
    this.observer?.disconnect();
    if (this.frame !== undefined) {
      cancelAnimationFrame(this.frame);
    }
  }

  private animate() {
    const target = this.appCountUp ?? 0;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      this.setValue(target);
      return;
    }
    const start = performance.now();
    const tick = (now: number) => {
      const progress = Math.min((now - start) / this.duration, 1);
      // Ease-out cubic for a smooth settle on the final value.
      const eased = 1 - Math.pow(1 - progress, 3);
      this.setValue(target * eased);
      if (progress < 1) {
        this.frame = requestAnimationFrame(tick);
      }
    };
    this.frame = requestAnimationFrame(tick);
  }

  private setValue(value: number) {
    this.el.nativeElement.textContent =
      `${this.prefix}${value.toFixed(this.decimals)}${this.suffix}`;
  }
}
