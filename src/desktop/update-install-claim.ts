/** Keeps the install claimed until hand-over starts, even after file staging has finished. */
export class UpdateInstallClaim {
  private claimed = false;

  get active(): boolean {
    return this.claimed;
  }

  /** Gives the claim back after an install that did not end this process (a live update). */
  release(): void {
    this.claimed = false;
  }

  async run<T>(status: () => T, inProgress: () => boolean, install: () => Promise<T>): Promise<T> {
    if (this.claimed || inProgress()) return status();
    this.claimed = true;
    try {
      return await install();
    } catch (error) {
      this.claimed = false;
      throw error;
    }
  }
}
