/**
 * 主入口。
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

const container = document.getElementById('root');
if (!container) {
    throw new Error('缺少 #root 容器');
}

createRoot(container).render(
    <StrictMode>
        <App />
    </StrictMode>,
);

// 仅开发环境加载测试钩子：生产构建中该分支会被移除
if (import.meta.env.DEV) {
    void import('./devHooks');
}
