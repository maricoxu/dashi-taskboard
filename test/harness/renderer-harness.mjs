export class RendererHarness {
  constructor() {
    this.state = "closed";
    this.mountCount = 0;
    this.unmountCount = 0;
    this.crashCount = 0;
    this.recoveryCount = 0;
  }

  mount() {
    if (this.state === "ready") return;
    this.state = "ready";
    this.mountCount += 1;
  }

  unmount() {
    if (this.state === "closed") return;
    this.state = "closed";
    this.unmountCount += 1;
  }

  crash() {
    this.state = "crashed";
    this.crashCount += 1;
  }

  recover() {
    if (this.state !== "crashed") throw new Error("renderer is not crashed");
    this.state = "ready";
    this.recoveryCount += 1;
  }

  assertReady() {
    if (this.state !== "ready") throw new Error(`renderer is ${this.state}`);
  }
}
