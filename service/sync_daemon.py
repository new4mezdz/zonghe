import time
import traceback
from datetime import datetime

import sync_to_sqlite

# 每轮同步之间的间隔(秒)
INTERVAL_SECONDS = 60  # 1 分钟


def run_once():
    start = datetime.now()
    print(f"\n========== Sync round start: {start:%Y-%m-%d %H:%M:%S} ==========")
    try:
        sync_to_sqlite.main()
    except Exception:
        print("Sync round crashed:")
        traceback.print_exc()
    end = datetime.now()
    print(f"========== Sync round end: {end:%Y-%m-%d %H:%M:%S} (took {(end-start).total_seconds():.1f}s) ==========")


def main():
    print(f"Daemon started. Interval = {INTERVAL_SECONDS}s. Press Ctrl+C to stop.")
    while True:
        run_once()
        print(f"Sleeping {INTERVAL_SECONDS}s ...")
        try:
            time.sleep(INTERVAL_SECONDS)
        except KeyboardInterrupt:
            print("\nDaemon stopped by user.")
            break


if __name__ == "__main__":
    main()