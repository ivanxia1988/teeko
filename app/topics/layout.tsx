import type { ReactNode } from 'react';
import '../../components/product/product.css';
import '../../components/topics/topics.css';

export const metadata = { title: '主题学习 · Teeko', description: '挑一个感兴趣的主题，和 Teeko 一起阅读、交流、练习英语。' };
export default function TopicsLayout({ children }: { children: ReactNode }) { return children; }
