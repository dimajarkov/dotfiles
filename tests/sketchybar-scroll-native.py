#!/usr/bin/env python3
"""Compile the pinned event handler with deterministic CoreGraphics/bar stubs.

No live event injection, desktop changes, service launch or accessibility access.
Pass --source to the unpacked SketchyBar source, optionally --patch to test our patch.
"""

import argparse
import os
from pathlib import Path
import subprocess
import tempfile


HARNESS = r"""
#include <assert.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#define CLOCK_MONOTONIC_RAW_APPROX 0
#define BAR_COMPONENT_GROUP 1
#define UPDATE_MOUSE_SCROLLED 1
#define kCGScrollWheelEventDeltaAxis1 1
#define kCGScrollWheelEventDeltaAxis2 2
#define kCGScrollWheelEventFixedPtDeltaAxis1 3
#define kCGScrollWheelEventFixedPtDeltaAxis2 4
#define kCGScrollWheelEventIsContinuous 5
#define kCGScrollWheelEventScrollPhase 6
#define kCGScrollWheelEventMomentumPhase 7
#define kCGScrollPhaseBegan 1
#define kCGScrollPhaseEnded 4
#define kCGScrollPhaseCancelled 8
typedef struct {double x, y;} CGPoint;
struct bar_item {char *name; int type, update_mask; bool needs_update; uint32_t associated_display;};
struct bar {bool mouse_over; int adid;};
struct popup {bool mouse_over; int adid;};
struct {int unused;} g_bar_manager;
struct event {double x, y; int continuous, phase, momentum, wid;};
static struct bar_item item = {.name="wsc.space.opaque.d1", .update_mask=1, .associated_display=1};
static int hovered_wid = 1;
static uint64_t now = 1000000000;
static double out_x, out_y;
static int calls;
static int global_calls;
static CGPoint CGEventGetLocation(void *event) {return (CGPoint){0, 0};}
static uint32_t get_wid_from_cg_event(void *event) {return ((struct event*)event)->wid;}
static uint32_t CGEventGetFlags(void *event) {return 0;}
static int64_t CGEventGetIntegerValueField(void *context, int field) {
  struct event *e = context;
  switch (field) {
    case kCGScrollWheelEventDeltaAxis1: return e->y;
    case kCGScrollWheelEventDeltaAxis2: return e->x;
    case kCGScrollWheelEventIsContinuous: return e->continuous;
    case kCGScrollWheelEventScrollPhase: return e->phase;
    case kCGScrollWheelEventMomentumPhase: return e->momentum;
  }
  return 0;
}
static double CGEventGetDoubleValueField(void *context, int field) {
  struct event *e = context;
  return field == kCGScrollWheelEventFixedPtDeltaAxis1 ? e->y : e->x;
}
static uint64_t clock_gettime_nsec_np(int clock) {return now;}
static struct bar_item *bar_manager_get_item_by_wid(void *m, int wid, void *w) {return wid ? &item : NULL;}
static struct bar_item *bar_manager_get_item_by_point(void *m, CGPoint p, void *w) {return NULL;}
static struct bar global_bar = {.mouse_over=true, .adid=1};
static struct bar *bar_manager_get_bar_by_wid(void *m, int wid) {return wid ? NULL : &global_bar;}
static struct popup *bar_manager_get_popup_by_wid(void *m, int wid) {return NULL;}
static bool bar_manager_mouse_over_any_popup(void *m) {return false;}
static bool bar_manager_mouse_over_any_bar(void *m) {return false;}
static void bar_manager_handle_mouse_scrolled_global(void *m, int d, int a, int k) {global_calls++;}
static void bar_manager_refresh(void *m, bool a, bool b) {}
#define COMMAND_SUBSCRIBE_MOUSE_SCROLLED "mouse.scrolled"
struct env_vars {char *keys[16], *values[16]; int count;};
static void env_vars_init(struct env_vars *e) {e->count = 0;}
static char *string_copy(const char *s) {char *r = malloc(strlen(s) + 1); strcpy(r, s); return r;}
static void env_vars_set(struct env_vars *e, char *k, char *v) {
  e->keys[e->count] = k; e->values[e->count++] = v;
}
static void env_vars_destroy(struct env_vars *e) {
  for (int i = 0; i < e->count; ++i) {free(e->keys[i]); free(e->values[i]);}
}
static char *get_modifier_description(uint32_t modifier) {return "none";}
static bool bar_item_update(struct bar_item *i, char *sender, bool forced, struct env_vars *e) {
  out_x = out_y = 0;
  for (int j = 0; j < e->count; ++j) {
    if (!strcmp(e->keys[j], "SCROLL_DELTA")) out_y = atof(e->values[j]);
    if (!strcmp(e->keys[j], "SCROLL_DELTA_X")) out_x = atof(e->values[j]);
  }
  calls++;
  return true;
}
/* ACTUAL_ITEM_SCROLL */
/* ACTUAL_HANDLER */
static void send(double x, double y, int continuous, int phase, int momentum, uint64_t elapsed) {
  now += elapsed;
  struct event e = {x, y, continuous, phase, momentum, hovered_wid};
  event_mouse_scrolled(&e);
}
int main(void) {
  send(1, 0, 1, 1, 0, 1000000000);
  if (out_x != 1 || out_y != 0) {
    fprintf(stderr, "horizontal-only gesture lost: SCROLL_DELTA_X=%g SCROLL_DELTA=%g\n", out_x, out_y);
    return 1;
  }
  send(-1, 0, 1, 1, 0, 400000000);
  assert(out_x == -1 && out_y == 0);
  int before = calls;
  send(0, 0, 1, 1, 0, 400000000);
  assert(calls == before);
  send(.2, 0, 1, 1, 0, 400000000);
  send(.2, 0, 1, 2, 0, 10000000);
  send(.2, 0, 1, 2, 0, 10000000);
  send(.2, 0, 1, 2, 0, 10000000);
  assert(calls == before);
  send(.3, 0, 1, 2, 0, 10000000);
  assert(calls == before + 1 && out_x == 1);
  before = calls;
  send(1, .9, 1, 1, 0, 400000000);
  assert(calls == before + 1 && out_x == 1 && out_y == 0);
  before = calls;
  send(1, 0, 1, 2, 0, 10000000);
  assert(calls == before); /* throttled within 150ms */
  send(1, 0, 1, 2, 1, 200000000);
  assert(calls == before); /* momentum never browses further */
  send(1, 0, 1, 1, 0, 400000000);
  send(5, 0, 1, 2, 0, 10000000);
  send(-1, 0, 1, 2, 0, 200000000);
  assert(out_x == -1); /* reversal cancels pending positive motion */
  send(0, -1, 1, 1, 0, 400000000);
  assert(out_y == -1 && out_x == 0);
  send(.2, -1, 1, 1, 0, 400000000);
  assert(out_y == -1 && out_x == 0);
  before = calls;
  hovered_wid = 101;
  send(1, 0, 1, 1, 0, 400000000);
  hovered_wid = 102;
  item.name = "wsc.app.opaque.d1";
  send(1, 0, 1, 2, 0, 10000000);
  hovered_wid = 103;
  item.name = "wsc.next.d1";
  send(1, 0, 1, 2, 0, 10000000);
  if (calls != before + 1) {
    fprintf(stderr, "item boundary bypassed viewport throttle: %d dispatches in 20ms\n", calls - before);
    return 1;
  }
  before = calls;
  hovered_wid = 201;
  send(.4, 0, 1, 1, 0, 400000000);
  hovered_wid = 202;
  send(.4, 0, 1, 2, 0, 10000000);
  hovered_wid = 203;
  send(.3, 0, 1, 2, 0, 10000000);
  assert(calls == before + 1 && out_x == 1); /* fractions survive item boundaries */
  before = calls;
  item.associated_display = 2;
  item.name = "wsc.space.opaque.d2";
  hovered_wid = 301;
  send(1, 0, 1, 1, 0, 10000000);
  assert(calls == before + 1); /* another display is not throttled by display 1 */
  item.associated_display = 1;
  item.name = "wsc.space.opaque.d1";
  hovered_wid = 204;
  send(1, 0, 1, 2, 0, 10000000);
  assert(calls == before + 1); /* returning to display 1 retains its throttle */
  send(0, 0, 1, 4, 0, 200000000);
  before = calls;
  send(.6, 0, 1, 1, 0, 400000000);
  item.associated_display = 2;
  send(.6, 0, 1, 1, 0, 10000000);
  assert(calls == before); /* displays do not share fractional input */
  item.associated_display = 1;
  send(.5, 0, 1, 2, 0, 10000000);
  assert(calls == before + 1);
  item.associated_display = 2;
  send(.5, 0, 1, 2, 0, 10000000);
  assert(calls == before + 2); /* returning preserves each display's fractions */
  item.associated_display = 1;
  send(1, 0, 1, 1, 0, 10000000);
  assert(calls == before + 2); /* even a new gesture cannot bypass the deadline */
  before = calls;
  send(.6, 0, 1, 1, 0, 400000000);
  hovered_wid = 205;
  send(.6, 0, 1, 1, 0, 200000000);
  assert(calls == before); /* a fresh gesture resets old fractions */
  item.name = "clock";
  before = calls;
  send(3, 2, 0, 0, 0, 1000000000);
  assert(calls == before + 1 && out_y == 2 && out_x == 0);
  item.name = "wsc.space.unsubscribed.d1";
  item.update_mask = 0;
  before = calls;
  send(1, 0, 1, 1, 0, 1000000000);
  assert(calls == before); /* not subscribed: no new horizontal events */
  now += 1000000000;
  struct event global_event = {3, 2, 0, 0, 0, 0};
  event_mouse_scrolled(&global_event);
  assert(global_calls == 1);
  puts("native scroll: horizontal +/-; zero; fractional; diagonal; throttle across items; display isolation; gesture reset; momentum; vertical; legacy OK");
}
"""


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--patch", type=Path)
    args = parser.parse_args()
    with tempfile.TemporaryDirectory() as temp:
        directory = Path(temp)
        source = (args.source / "src/event.c").read_text()
        item_source = (args.source / "src/bar_item.c").read_text()
        if args.patch:
            (directory / "src").mkdir()
            for name in ("event.c", "bar_item.c", "bar_item.h"):
                (directory / "src" / name).write_text(
                    (args.source / "src" / name).read_text()
                )
            subprocess.run(
                ["patch", "-p1", "-i", str(args.patch.resolve())],
                cwd=directory,
                check=True,
            )
            source = (directory / "src/event.c").read_text()
            item_source = (directory / "src/bar_item.c").read_text()
        handler = source[
            source.index("#define SCROLL_TIMEOUT") : source.index(
                "static void event_volume_changed"
            )
        ]
        code = directory / "scroll.c"
        start = item_source.find("static void bar_item_on_scroll_axis(")
        if start < 0:
            start = item_source.index("void bar_item_on_scroll(")
        item_handler = item_source[
            start : item_source.index("void bar_item_mouse_entered(")
        ]
        code.write_text(
            HARNESS.replace("/* ACTUAL_HANDLER */", handler).replace(
                "/* ACTUAL_ITEM_SCROLL */", item_handler
            )
        )
        executable = directory / "scroll"
        subprocess.run(
            [
                os.environ.get("CC", "cc"),
                "-std=c11",
                "-Wno-unused-function",
                str(code),
                "-o",
                str(executable),
            ],
            check=True,
        )
        subprocess.run([str(executable)], check=True)


if __name__ == "__main__":
    main()
