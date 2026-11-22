import { TopicAccount } from '../../../components/topics/topic-account';
import { accountIntent } from '../../../components/product/account-state';

export const metadata = { title: '登录 · Teeko 主题学习' };
export default async function TopicLoginPage({ searchParams }: { searchParams: Promise<{ intent?: string | string[]; next?: string | string[] }> }) {
  const query = await searchParams;
  const intent = accountIntent(typeof query.intent === 'string' ? query.intent : undefined);
  return <TopicAccount key={`${intent}:${typeof query.next === 'string' ? query.next : ''}`} intent={intent} next={typeof query.next === 'string' ? query.next : undefined} />;
}
