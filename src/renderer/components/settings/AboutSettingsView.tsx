import { Info } from 'lucide-react';
import { useId, useState } from 'react';
import { APP_VERSION, BETA_APP_NAME } from '../../../shared/appRelease';

const noticeDocuments = [
  { title: '第三方声明', load: () => import('../../../../THIRD_PARTY_NOTICES.md?raw') },
  { title: '第三方许可证原文', load: () => import('../../../../third_party/licenses/THIRD_PARTY_LICENSES.txt?raw') },
];

function NoticeDocument({ title, load }: typeof noticeDocuments[number]) {
  const id = useId();
  const [expanded, setExpanded] = useState(false);
  const [text, setText] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const toggle = async () => {
    if (expanded) { setExpanded(false); return; }
    setExpanded(true);
    if (text !== undefined || loading) return;
    setLoading(true);
    setError(false);
    try { setText((await load()).default); }
    catch { setError(true); }
    finally { setLoading(false); }
  };
  return <div className="about-notice">
    <button className="secondary-button" type="button" aria-expanded={expanded} aria-controls={id} onClick={() => void toggle()}>{expanded ? '收起' : '查看'}{title}</button>
    {expanded && <div id={id}>
      {loading && <p role="status">正在读取随应用提供的声明…</p>}
      {error && <p role="alert">声明暂时无法读取，请收起后重试。</p>}
      {text !== undefined && <pre className="about-notice-text" tabIndex={0} aria-label={title}>{text}</pre>}
    </div>}
  </div>;
}

export function AboutSettingsView() {
  return <>
    <header className="settings-heading"><div><span><Info size={24} /></span><div><h1>关于星丛</h1><p>让熟悉你的 AI 伙伴，在同一个工作台相伴与协作。</p></div></div></header>
    <div className="general-settings about-settings">
      <section className="general-settings-card">
        <h2>星丛 Asterium</h2>
        <p>星丛是一款面向重视长期对话、伙伴性格与记忆连续性，也需要完成简单编程任务的使用者的桌面工作台。你可以与伙伴单独交流，也可以邀请多个伙伴进入工作室，分工、交接和互相校验，减少反复搬运需求与上下文。</p>
        <dl className="about-release"><dt>客户端</dt><dd>{BETA_APP_NAME}</dd><dt>版本</dt><dd>{APP_VERSION}</dd><dt>发布阶段</dt><dd>Beta · 功能与兼容性仍在验收和完善中</dd></dl>
      </section>
      <section className="general-settings-card">
        <h2>数据与连接</h2>
        <p>伙伴资料、对话与设置保存在本机；使用模型或外部工具时，相关内容会发往你配置的服务。本地伙伴调用你另行安装并登录的官方 CLI，星丛不接管其订阅登录凭据。</p>
        <p>星丛可管理启用托管后的伙伴资料、记忆条目和相关文件。已有记忆导入能力仍在确认／尚未提供，不会自动继承外部历史。</p>
      </section>
      <section className="general-settings-card">
        <h2>许可证与第三方声明</h2>
        <p>客户端拟全开源并采用 MPL-2.0，目前尚未正式落地项目许可证；公开发布前仍需完成剩余第三方许可核查。第三方原始条款各自适用，不代表星丛自身已经获得开源许可。</p>
        <p>下方可离线查看随应用提供的声明与收集的许可证原文。Electron 与 Chromium 的原始声明另随应用目录中的 LICENSE 和 LICENSES.chromium.html 提供。</p>
        {noticeDocuments.map(document => <NoticeDocument key={document.title} {...document} />)}
      </section>
      <section className="general-settings-card">
        <h2>当前发行说明</h2>
        <p>当前本地 Beta 候选未配置代码签名。客户端自动检查更新尚未提供；后续版本需取得新安装包后手动安装。</p>
      </section>
    </div>
  </>;
}
