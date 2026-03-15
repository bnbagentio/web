export default function HomePage() {
  return (
    <main style={{ width: '100%', minHeight: '100vh', background: '#05070a' }}>
      <iframe
        src="/bnbagent-ui.html"
        title="BNBAgent UI"
        style={{ width: '100%', minHeight: '100vh', border: '0', display: 'block' }}
      />
    </main>
  );
}
