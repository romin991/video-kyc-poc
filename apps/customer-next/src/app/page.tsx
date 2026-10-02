export default function HomePage() {
  return (
    <div className="frame">
      <div className="device">
        <header className="device-bar">
          <span className="mark" aria-hidden="true" />
          <div>
            <p>Superbank</p>
            <strong>Video verification</strong>
          </div>
        </header>
        <div className="device-body">
          <div className="stack">
            <h1>Open your join link</h1>
            <p>The agent desk copies a link after it creates a session. It looks like this:</p>
            <p className="mono">/join/…</p>
            <p>Keep that window open. The call starts when the agent accepts the session.</p>
          </div>
        </div>
      </div>
    </div>
  );
}
