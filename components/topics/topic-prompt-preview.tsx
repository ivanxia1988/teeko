import type { TopicPromptPreview } from '../../lib/topic-prompt-preview';

function PromptText({ field, text }: { field: string; text: string }) {
  return <div className="tk-topic-prompt-field">
    <p><code>{field}</code></p>
    <pre aria-label={field}><code>{text}</code></pre>
  </div>;
}

export function TopicPromptPanel({ preview }: { preview: TopicPromptPreview }) {
  const { registrationJson, voiceModel, activities, silenceCue } = preview;

  return <details id="teacher-prompt" className="tk-topic-prompt" open>
    <summary>查看教师提示词</summary>
    <div className="tk-topic-prompt-body">
      <h2>GPT Live 工具注册</h2>
      <PromptText field="session.delegation" text={registrationJson}/>
      <h2>提示词原文 <code>{voiceModel}</code></h2>
      <p className="tk-topic-prompt-note">按当前发布配置和已保存的教学偏好生成。课堂 ID 和称呼使用示例值。</p>
      {activities.map((activity, index) => <details className="tk-topic-prompt-activity" key={activity.id} open={index === 0}>
        <summary>{activity.label}</summary>
        <PromptText field="session.instructions" text={activity.instructions}/>
        <PromptText field="session.input · 开场" text={activity.opening}/>
        {activity.backendInstructions && <PromptText field="delegation.responses.instructions" text={activity.backendInstructions}/>}
        {activity.contextUpdate && <PromptText field="session.thinking.append · 环节更新" text={activity.contextUpdate}/>}
        {activity.advance && <PromptText field="session.commentary.append · 环节衔接" text={activity.advance}/>}
      </details>)}
      <PromptText field="session.commentary.append · 静默提醒" text={silenceCue}/>
    </div>
  </details>;
}
