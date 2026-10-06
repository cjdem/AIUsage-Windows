/**
 * 设置（阶段 1 只读）：路径、日志、行为约定。
 * 按需求明确：不做开机自启；不写系统环境变量；不改 Science 二进制。
 */
import { el, card, kv } from '../dom.mjs';

export default {
  id: 'settings',
  label: '设置',
  icon: '⚙',

  mount(root, ctx) {
    function render() {
      const status = ctx.status;
      const versions = ctx.api.versions;
      root.replaceChildren();

      root.append(
        el('div', { class: 'grid two' }, [
          card('运行环境', '控制台自身的版本信息', [
            kv('Electron', versions.electron),
            kv('Chromium', versions.chrome),
            kv('Node（主进程）', versions.node),
            kv('平台', versions.platform),
            kv('控制台进程 pid', status?.hostPid, { mono: true }),
            kv('daemon 启动器 pid', status?.daemonPid, { mono: true }),
          ]),

          card('行为约定', '这些是设计上的硬约束，不是开关', [
            ...[
              ['开机自启', '不做（按需求明确排除；托盘也不会写注册表启动项）'],
              ['托盘', '仅手动运行时常驻；关闭窗口 = 收进托盘，链路继续跑'],
              ['退出', '托盘菜单「退出」才停链并退出应用'],
              ['系统环境变量', '不写。ANTHROPIC_BASE_URL 等只注入 daemon 子进程'],
              ['Science 二进制', '不修改'],
              ['上游密钥', '只存在于主进程内存与 config.json，日志与界面一律脱敏'],
              ['关闭窗口', '等于停止链路：两个代理跑在控制台进程内，daemon 会一并停止'],
              ['上游请求', '一律流式；客户端要非流式时由本地聚合'],
            ].map(([label, value]) => kv(label, value)),
          ]),
        ]),

        el('div', { class: 'grid two' }, [
          card('路径', '配置文件与运行产物', [
            kv('配置文件', status?.configPath, { mono: true }),
            kv('Science 数据目录', status?.science?.dataDir, { mono: true }),
            kv('Science 可执行文件', status?.science?.binaryPath, { mono: true }),
            kv('自动更新', status?.science?.noAutoUpdate ? '已关闭（--no-auto-update）' : '未关闭'),
            kv('日志目录', status?.logging?.dir, { mono: true }),
            kv('日志级别', status?.logging?.level),
          ]),

          card('快捷键与调试', '开发模式便利项', [
            kv('F12 / Ctrl+Shift+I', '开发者工具'),
            kv('Ctrl+R', '重新加载界面'),
            kv('状态轮询', '每 4 秒一次（启动/停止过程中由事件即时刷新）'),
            kv('日志缓冲', '界面保留最近 2000 行（环形，超出即丢最旧）'),
          ]),
        ]),
      );
    }

    render();
    return { update: render };
  },
};
