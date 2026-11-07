import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import FilePreview from '../../src/client/components/FilePreview';
import '../../src/client/styles.css';
import '../../src/client/reference-layout.css';

function Fixture() {
  const [name, select] = useState('live.md');
  const [active, activate] = useState(true);
  const [line, setLine] = useState<number | undefined>();
  const directory = new URLSearchParams(location.search).get('directory')!;
  return <main style={{ height: '100dvh', maxWidth: 720, margin: 'auto', display: 'flex', flexDirection: 'column' }}>
    <nav style={{ display: 'flex', gap: 8, flexWrap: 'wrap', padding: 8 }}>
      {['live.md', 'live.html', 'live.pdf', 'live.png', 'live.docx'].map(file => <button key={file}
        onClick={() => { select(file); setLine(undefined); }}>{file}</button>)}
      <button onClick={() => activate(value => !value)}>{active ? 'Hide' : 'Show'}</button>
      <button onClick={() => setLine(40)}>Line 40</button>
    </nav>
    <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
      <FilePreview key={name} active={active} target={{ kind: 'file', path: directory + '/' + name, line }} />
    </div>
  </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
