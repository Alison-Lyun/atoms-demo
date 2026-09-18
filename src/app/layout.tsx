import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Atoms — 把想法变成应用',
  description: '从一句话开始，生成、预览并持续改进你的应用。',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
