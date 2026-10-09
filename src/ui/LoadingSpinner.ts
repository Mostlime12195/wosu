import { Graphics } from 'pixi.js';
import { UIComponent } from './UIComponent';

/** lazer-style loading spinner: a rotating arc with eased sweep. */
export class LoadingSpinner extends UIComponent {
    private readonly g = new Graphics();
    private t = 0;

    constructor(private readonly radius = 16, private readonly color = 0xffffff, private readonly thickness = 4) {
        super();
        this.addChild(this.g);
        this.resize(radius * 2, radius * 2);
        this.g.position.set(radius, radius);
        this.eventMode = 'none';
        this.onFrame(dt => this.update(dt));
    }

    update(dt: number): void {
        if (!this.visible) return;
        this.t += dt;
        const g = this.g;
        const phase = (this.t % 1200) / 1200;
        // Sweep grows then shrinks while the whole arc rotates.
        const sweep = 0.25 + 0.5 * (0.5 - 0.5 * Math.cos(phase * Math.PI * 2));
        const start = (this.t / 600) * Math.PI;
        g.clear();
        g.arc(0, 0, this.radius - this.thickness / 2, start, start + sweep * Math.PI * 2);
        g.stroke({ width: this.thickness, color: this.color, cap: 'round' });
    }
}
