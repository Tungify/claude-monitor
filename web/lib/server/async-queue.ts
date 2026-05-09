import "server-only";

// AsyncQueue feeds the Agent SDK's prompt parameter, which expects an
// AsyncIterable that yields user messages over time. Push when the user
// sends a message; the SDK awaits the next yield to start its next turn.
//
// findIndex / removeAt / replaceAt support the "edit a queued message"
// flow: a message that's been pushed but the SDK hasn't yet pulled
// (i.e. still sitting in `values`) can be edited or yanked back. Once
// the SDK iterator has consumed it, the call returns -1 / undefined and
// the caller treats it as "too late, already in flight."
export class AsyncQueue<T> implements AsyncIterable<T> {
  private values: T[] = [];
  private resolvers: Array<(r: IteratorResult<T>) => void> = [];
  private closed = false;

  push(value: T): void {
    if (this.closed) throw new Error("queue is closed");
    const r = this.resolvers.shift();
    if (r) r({ value, done: false });
    else this.values.push(value);
  }

  end(): void {
    if (this.closed) return;
    this.closed = true;
    while (this.resolvers.length) {
      this.resolvers.shift()!({ value: undefined as never, done: true });
    }
  }

  // findIndex returns -1 when no matching item is still queued. A
  // message that's already been handed to the SDK iterator is gone
  // from `values` and not findable here — that's the signal callers
  // use to refuse a late edit.
  findIndex(predicate: (item: T) => boolean): number {
    return this.values.findIndex(predicate);
  }

  removeAt(index: number): T | undefined {
    if (index < 0 || index >= this.values.length) return undefined;
    return this.values.splice(index, 1)[0];
  }

  replaceAt(index: number, value: T): T | undefined {
    if (index < 0 || index >= this.values.length) return undefined;
    const previous = this.values[index];
    this.values[index] = value;
    return previous;
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.values.length) {
          return Promise.resolve({ value: this.values.shift()!, done: false });
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined as never, done: true });
        }
        return new Promise((resolve) => this.resolvers.push(resolve));
      },
    };
  }
}
