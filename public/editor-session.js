// A session owns its saved version and queue, even across asynchronous requests.
export class EditorSession {
  constructor(project, variant, { readState, write, status }) {
    this.project = project;
    this.variant = variant;
    this.revision = variant.revision;
    this.baseline = JSON.stringify(variant.plan);
    this.underlayBaseline = JSON.stringify(project.underlay);
    this.readState = readState;
    this.write = write;
    this.status = status;
    this.ready = false;
    this.active = true;
    this.saveTimer = null;
    this.savePromise = null;
  }
  endpoint(action) {
    return `/api/projects/${this.project.id}/variants/${this.variant.id}/${action}`;
  }
  matches(state) {
    return (
      JSON.stringify(state.plan) === this.baseline &&
      JSON.stringify(state.underlay) === this.underlayBaseline
    );
  }
  schedule(onError) {
    if (!this.active) return;
    this.status("有新修改", true);
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.save().catch(onError), 800);
  }
  async save(description = "手动编辑") {
    clearTimeout(this.saveTimer);
    if (!this.active || !this.ready) return;
    if (this.savePromise) {
      await this.savePromise;
      return this.save(description);
    }
    this.savePromise = this.flush(description);
    try {
      return await this.savePromise;
    } catch (error) {
      this.status("保存未完成 · 重试", true);
      throw error;
    } finally {
      this.savePromise = null;
    }
  }
  async flush(description) {
    while (this.active) {
      const state = await this.readState();
      if (state.gesture) throw new Error("请先结束当前拖动");
      if (this.matches(state)) {
        this.status("已保存");
        return state;
      }
      this.status("正在保存…");
      const result = await this.write(this.endpoint("save"), {
        revision: this.revision,
        plan: state.plan,
        underlay: state.underlay,
        description,
      });
      this.revision = result.revision;
      this.variant.plan = result.plan;
      this.project.underlay = result.underlay;
      this.baseline = JSON.stringify(state.plan);
      this.underlayBaseline = JSON.stringify(state.underlay);
      // Re-read after every write: edits arriving during the save must also persist.
    }
  }
  dispose() {
    clearTimeout(this.saveTimer);
    this.active = false;
    this.ready = false;
  }
}
