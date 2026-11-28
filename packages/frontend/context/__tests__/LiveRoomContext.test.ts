import { createLiveRoomRuntimeController } from '../LiveRoomContext';

describe('live room runtime controller', () => {
  it('requests the runtime and flushes the latest queued join once', () => {
    const controller = createLiveRoomRuntimeController();
    const firstJoin = jest.fn();
    const firstLeave = jest.fn();

    controller.joinLiveRoom('room-a');
    controller.joinLiveRoom('room-b');

    expect(controller.getSnapshot()).toEqual({
      activeRoomId: 'room-b',
      runtimeRequested: true,
    });

    const unbind = controller.bindRuntime({
      activeRoomId: null,
      joinLiveRoom: firstJoin,
      leaveLiveRoom: firstLeave,
    });

    expect(firstJoin).toHaveBeenCalledTimes(1);
    expect(firstJoin).toHaveBeenCalledWith('room-b');

    unbind();
    const replacementJoin = jest.fn();
    controller.bindRuntime({
      activeRoomId: 'room-b',
      joinLiveRoom: replacementJoin,
      leaveLiveRoom: jest.fn(),
    });

    expect(replacementJoin).not.toHaveBeenCalled();
  });

  it('keeps commands and room state in the persistent controller', () => {
    const controller = createLiveRoomRuntimeController();
    const joinLiveRoom = jest.fn();
    const leaveLiveRoom = jest.fn();
    const listener = jest.fn();
    controller.subscribe(listener);
    controller.bindRuntime({
      activeRoomId: null,
      joinLiveRoom,
      leaveLiveRoom,
    });

    controller.requestRuntime();
    controller.requestRuntime();
    controller.joinLiveRoom('room-live');
    controller.leaveLiveRoom();

    expect(joinLiveRoom).toHaveBeenCalledWith('room-live');
    expect(leaveLiveRoom).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot()).toEqual({
      activeRoomId: null,
      runtimeRequested: true,
    });
    // request, join and leave publish; the duplicate request is idempotent.
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it('drops active and queued room state at the identity boundary', () => {
    const controller = createLiveRoomRuntimeController();
    const joinLiveRoom = jest.fn();
    const leaveLiveRoom = jest.fn();

    controller.bindRuntime({
      activeRoomId: null,
      joinLiveRoom,
      leaveLiveRoom,
    });
    controller.joinLiveRoom('room-a');
    controller.resetViewerState();

    expect(joinLiveRoom).toHaveBeenCalledWith('room-a');
    expect(leaveLiveRoom).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot()).toEqual({
      activeRoomId: null,
      runtimeRequested: false,
    });

    const queuedController = createLiveRoomRuntimeController();
    queuedController.joinLiveRoom('room-from-previous-viewer');
    queuedController.resetViewerState();

    const replacementJoin = jest.fn();
    queuedController.bindRuntime({
      activeRoomId: null,
      joinLiveRoom: replacementJoin,
      leaveLiveRoom: jest.fn(),
    });

    expect(replacementJoin).not.toHaveBeenCalled();
    expect(queuedController.getSnapshot()).toEqual({
      activeRoomId: null,
      runtimeRequested: false,
    });
  });
});
