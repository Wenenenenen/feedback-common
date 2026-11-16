import './style.css';
import { createApp } from './main';

const root = document.getElementById('app');
if (!root) throw new Error('缺少 #app 根元素');
createApp(root);
