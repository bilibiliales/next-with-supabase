import { RoomPage } from "../../../features/room/room-page";

export default function Page({ params }: { params: { id: string } }) {
  return <RoomPage roomId={params.id} />;
}
