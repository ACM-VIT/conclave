export type SocketBudgetMember = {
  releaseSpare(): boolean;
  wake(): void;
};

export class SocketBudget {
  private held = 0;
  private readonly members = new Set<SocketBudgetMember>();
  private readonly hungry = new Set<SocketBudgetMember>();
  private waiters: (() => void)[] = [];

  constructor(readonly limit: number) {}

  get inUse(): number {
    return this.held;
  }

  join(member: SocketBudgetMember): void {
    this.members.add(member);
  }

  leave(member: SocketBudgetMember): void {
    this.members.delete(member);
    this.hungry.delete(member);
  }

  take(asker?: SocketBudgetMember): boolean {
    if (this.held >= this.limit && this.waiters.length === 0) this.releaseOne();
    if (this.held < this.limit && this.waiters.length === 0) {
      this.held += 1;
      if (asker) this.hungry.delete(asker);
      return true;
    }
    if (asker) this.hungry.add(asker);
    return false;
  }

  give(): void {
    this.held = Math.max(0, this.held - 1);
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter();
      return;
    }
    const hungry = Array.from(this.hungry);
    this.hungry.clear();
    if (hungry.length > 0) queueMicrotask(() => hungry.forEach((member) => member.wake()));
  }

  offer(): void {
    if (this.waiters.length > 0 || this.hungry.size > 0) this.releaseOne();
  }

  acquire(signal?: AbortSignal): Promise<void> {
    if (this.take()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const grant = () => {
        signal?.removeEventListener("abort", abort);
        this.held += 1;
        resolve();
      };
      const abort = () => {
        this.waiters = this.waiters.filter((waiter) => waiter !== grant);
        reject(new Error("Transcript provider connection timed out."));
      };
      if (signal?.aborted) {
        abort();
        return;
      }
      signal?.addEventListener("abort", abort, { once: true });
      this.waiters.push(grant);
      this.releaseOne();
    });
  }

  private releaseOne(): boolean {
    for (const member of this.members) {
      if (member.releaseSpare()) return true;
    }
    return false;
  }
}
