// Finish the media seek before any canvas stream or recorder is created.
export async function rewindForExport(player, paintFirstFrame, timeoutMs = 5000) {
  player.pause();
  if (player.currentTime !== 0 || player.seeking) {
    await new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); player.removeEventListener('seeked', done); player.removeEventListener('error', failed); };
      const done = () => { if (player.seeking) return; cleanup(); resolve(); };
      const failed = () => { cleanup(); reject(new Error('Could not return to the beginning. Try loading the clip again.')); };
      const timer = setTimeout(failed, timeoutMs);
      player.addEventListener('seeked', done); player.addEventListener('error', failed);
      player.currentTime = 0;
      if (!player.seeking) done();
    });
  }
  paintFirstFrame();
}
