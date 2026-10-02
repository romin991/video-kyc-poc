import { EnterQueue } from "@/app/enter-queue";

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
          <EnterQueue />
        </div>
      </div>
    </div>
  );
}
