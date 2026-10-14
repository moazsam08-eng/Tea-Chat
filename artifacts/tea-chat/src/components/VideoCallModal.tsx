import {
  CallControls,
  SpeakerLayout,
  StreamCall,
  StreamVideo,
  StreamVideoClient,
} from '@stream-io/video-react-sdk';
import type { Call } from '@stream-io/video-react-sdk';
import { X } from 'lucide-react';
import '@stream-io/video-react-sdk/dist/css/styles.css';

type VideoUser = { id: string; name: string; image?: string };

export async function createVideoClient({
  apiKey,
  user,
  token,
}: {
  apiKey: string;
  user: VideoUser;
  token: string;
}) {
  const client = new StreamVideoClient({ apiKey, user, token });
  await client.connectUser(user, token);
  return client;
}

export default function VideoCallModal({
  call,
  client,
  onLeave,
}: {
  call: Call;
  client: StreamVideoClient;
  onLeave: () => void;
}) {
  return (
    <div className="video-call-overlay" data-testid="dialog-video-call">
      <div className="video-call-panel">
        <button
          type="button"
          onClick={() => {
            void call.leave().catch(() => undefined);
            onLeave();
          }}
          className="video-call-leave"
          aria-label="Leave call"
          data-testid="button-leave-call"
        >
          <X size={17} />
        </button>
        <StreamVideo client={client}>
          <StreamCall call={call}>
            <SpeakerLayout />
            <CallControls />
          </StreamCall>
        </StreamVideo>
      </div>
    </div>
  );
}
