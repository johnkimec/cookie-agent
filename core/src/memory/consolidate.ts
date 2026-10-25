/** Expire, merge, and rebuild derived memory. The work is a later step. */
export type Consolidate = () => Promise<void>;

export class InMemoryConsolidator {
  runs = 0;

  readonly consolidate: Consolidate = async () => {
    this.runs += 1;
  };
}
