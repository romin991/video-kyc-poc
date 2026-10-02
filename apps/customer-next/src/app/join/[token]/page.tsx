import { JoinScreen } from "./join-screen";

export default async function JoinPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <JoinScreen token={token} />;
}
