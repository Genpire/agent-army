/**
 * GitLab client: a placeholder until the GitLab work package replaces it with the
 * real client (implements CodeHost, see code-host.ts).
 */
import { type CodeHost, type HostViewer, NotImplementedError } from "./code-host.js";
import type { PrRef } from "./github.js";

export interface GitLabOptions { token: string; baseUrl?: string }

export class GitLab implements CodeHost {
  readonly kind = "gitlab" as const;
  constructor(readonly options: GitLabOptions) {}
  private todo(what: string): never {
    throw new NotImplementedError(`GitLab ${what}`);
  }
  cloneUrl(_repo: string): string { return this.todo("cloneUrl"); }
  gitAuthArgs(): string[] { return this.todo("gitAuthArgs"); }
  secrets(): string[] { return [this.options.token]; }
  async viewer(): Promise<HostViewer> { return this.todo("viewer"); }
  commitIdentity(pointerName: string, _viewer: HostViewer | undefined) { return { name: pointerName, email: "pointer@agent-army.invalid" }; }
  async defaultBranch(_repo: string): Promise<string> { return this.todo("defaultBranch"); }
  async findOpenPr(_repo: string, _branch: string): Promise<PrRef | null> { return this.todo("findOpenPr"); }
  async createPr(): Promise<PrRef> { return this.todo("createPr"); }
  async commentOnPr(): Promise<void> { return this.todo("commentOnPr"); }
  async updatePr(): Promise<void> { return this.todo("updatePr"); }
  async markReady(): Promise<void> { return this.todo("markReady"); }
  async getPull(): Promise<never> { return this.todo("getPull"); }
  async prFeedback(): Promise<never[]> { return this.todo("prFeedback"); }
  async issueComments(): Promise<never[]> { return this.todo("issueComments"); }
  prWebUrl(_repo: string, _number: number): string { return this.todo("prWebUrl"); }
  async checksFor(): Promise<never> { return this.todo("checksFor"); }
  async checkAnnotations(): Promise<never[]> { return []; }
  async jobLog(): Promise<string | undefined> { return undefined; }
  async deploymentsFor(): Promise<never[]> { return []; }
  async deploymentStatuses(): Promise<never[]> { return []; }
  async listRepos(): Promise<never[]> { return this.todo("listRepos"); }
  async recentCommits(): Promise<never[]> { return this.todo("recentCommits"); }
  async listPulls(): Promise<never[]> { return this.todo("listPulls"); }
  async listIssues(): Promise<never[]> { return this.todo("listIssues"); }
  async readFile(): Promise<never> { return this.todo("readFile"); }
  async searchCode(): Promise<never[]> { return this.todo("searchCode"); }
}
