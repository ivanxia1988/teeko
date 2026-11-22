'use client';

import { useEffect, useRef } from 'react';
import { TOPIC_TERMS, TOPIC_TERMS_VERSION } from '../../lib/topic-terms';

export function TopicAgreementNotice({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);
  return <dialog className="tk-agreement" ref={dialog} onCancel={event => { event.preventDefault(); onClose(); }} onClose={onClose} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); } }} aria-labelledby="tk-topic-agreement-title">
    <h2 id="tk-topic-agreement-title">用户协议</h2>
    <p>主题学习 · {TOPIC_TERMS_VERSION}</p>
    <div className="tk-agreement-copy">{TOPIC_TERMS.map(section => <section key={section.title}><h3>{section.title}</h3><p>{section.text}</p></section>)}</div>
    <button type="button" className="tk-submit" onClick={onClose} autoFocus>知道了</button>
  </dialog>;
}
