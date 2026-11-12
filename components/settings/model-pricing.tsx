"use client";

const models = [
  { name: "Gemini 3.8 Flash", input: "¥2.00", output: "¥10.00", read: "¥0.30" },
  { name: "GPT-6 Luna", input: "¥0.40", output: "¥2.00", read: "¥0.50" },
] as const;

export function ModelPricing() {
  return <div className="model-pricing-page">
    <p className="model-pricing-intro">每 100 万 Token 的价格</p>
    {models.map(model => <section className="app-card model-pricing-card" key={model.name}>
      <h3>{model.name}</h3>
      <dl className="model-pricing-list">
        <div><dt>输入</dt><dd>{model.input}</dd></div>
        <div><dt>输出</dt><dd>{model.output}</dd></div>
        <div><dt>缓存读取</dt><dd>{model.read}</dd></div>
      </dl>
    </section>)}
    <section className="app-card model-pricing-card">
      <h3>Claude Opus 4.6 Thinking</h3>
      <dl className="model-pricing-list">
        <div><dt>输入</dt><dd>¥10</dd></div>
        <div><dt>输出</dt><dd>¥50</dd></div>
        <div><dt>缓存读取</dt><dd>¥1</dd></div>
      </dl>
    </section>
  </div>;
}
