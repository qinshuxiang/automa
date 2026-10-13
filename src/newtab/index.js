import { createApp } from 'vue';
import { createHead } from '@vueuse/head';
import { checkRestoreJournal } from '@/utils/backupRestore';
import App from './App.vue';
import router from './router';
import pinia from '../lib/pinia';
import compsUi from '../lib/compsUi';
import vueI18n from '../lib/vueI18n';
import vRemixicon, { icons } from '../lib/vRemixicon';
import vueToastification from '../lib/vue-toastification';
import '../assets/css/tailwind.css';
import '../assets/css/fonts.css';
import '../assets/css/style.css';
import '../assets/css/flow.css';

// 前台恢复门禁初始化：后台负责执行恢复，前台启动时检查恢复日志——
// 存在未完成的恢复快照则保持阻塞，否则解除"正在恢复本地数据"的恒定阻塞
checkRestoreJournal();

const head = createHead();

createApp(App)
  .use(head)
  .use(router)
  .use(compsUi)
  .use(pinia)
  .use(vueI18n)
  .use(vueToastification)
  .use(vRemixicon, icons)
  .mount('#app');

if (module.hot) module.hot.accept();
