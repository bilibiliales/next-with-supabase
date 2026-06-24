import { GamePage } from "../../../features/game/game-page";

export default function Page({ params }: { params: { id: string } }) {
  return <GamePage gameId={params.id} />;
}
