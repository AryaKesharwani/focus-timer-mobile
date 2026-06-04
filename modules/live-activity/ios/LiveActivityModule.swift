import ActivityKit
import ExpoModulesCore
import Foundation

public class LiveActivityModule: Module {
  private var currentActivityId: String?

  public func definition() -> ModuleDefinition {
    Name("LiveActivityModule")

    Function("isSupported") { () -> Bool in
      if #available(iOS 16.2, *) {
        return ActivityAuthorizationInfo().areActivitiesEnabled
      }
      return false
    }

    AsyncFunction("start") { (args: [String: Any], promise: Promise) in
      guard #available(iOS 16.2, *) else {
        promise.reject("UNSUPPORTED", "Live Activities require iOS 16.2+")
        return
      }
      guard ActivityAuthorizationInfo().areActivitiesEnabled else {
        promise.reject("NOT_AUTHORIZED", "Live Activities are disabled in Settings")
        return
      }

      let startTimeMs = (args["startTime"] as? Double) ?? Date().timeIntervalSince1970 * 1000
      let endTimeMs = (args["endTime"] as? Double) ?? 0
      let total = (args["totalDuration"] as? Double) ?? 0
      let mode = (args["mode"] as? String) ?? "focus"
      let label = (args["label"] as? String) ?? ""

      // End any existing activity before starting a new one.
      Task {
        if let id = self.currentActivityId {
          for activity in Activity<FocusTimerAttributes>.activities where activity.id == id {
            await activity.end(nil, dismissalPolicy: .immediate)
          }
          self.currentActivityId = nil
        }

        do {
          let attributes = FocusTimerAttributes(
            startTime: Date(timeIntervalSince1970: startTimeMs / 1000),
            totalDuration: total
          )
          let state = FocusTimerAttributes.ContentState(
            endTime: Date(timeIntervalSince1970: endTimeMs / 1000),
            mode: mode,
            label: label,
            isPaused: false,
            pausedRemainingSec: 0
          )
          let activity = try Activity.request(
            attributes: attributes,
            content: ActivityContent(state: state, staleDate: nil)
          )
          self.currentActivityId = activity.id
          promise.resolve(activity.id)
        } catch {
          promise.reject("START_FAILED", error.localizedDescription)
        }
      }
    }

    AsyncFunction("update") { (args: [String: Any], promise: Promise) in
      guard #available(iOS 16.2, *) else {
        promise.resolve(nil)
        return
      }
      let endTimeMs = (args["endTime"] as? Double) ?? 0
      let mode = (args["mode"] as? String) ?? "focus"
      let label = (args["label"] as? String) ?? ""
      let isPaused = (args["isPaused"] as? Bool) ?? false
      let pausedRemainingSec = (args["pausedRemainingSec"] as? Double) ?? 0

      Task {
        guard let id = self.currentActivityId,
              let activity = Activity<FocusTimerAttributes>.activities.first(where: { $0.id == id })
        else {
          promise.resolve(nil)
          return
        }
        let state = FocusTimerAttributes.ContentState(
          endTime: Date(timeIntervalSince1970: endTimeMs / 1000),
          mode: mode,
          label: label,
          isPaused: isPaused,
          pausedRemainingSec: pausedRemainingSec
        )
        await activity.update(ActivityContent(state: state, staleDate: nil))
        promise.resolve(nil)
      }
    }

    AsyncFunction("end") { (promise: Promise) in
      guard #available(iOS 16.2, *) else {
        promise.resolve(nil)
        return
      }
      Task {
        if let id = self.currentActivityId,
           let activity = Activity<FocusTimerAttributes>.activities.first(where: { $0.id == id }) {
          await activity.end(nil, dismissalPolicy: .immediate)
        }
        // Also clean any orphaned activities from a previous launch.
        for activity in Activity<FocusTimerAttributes>.activities {
          await activity.end(nil, dismissalPolicy: .immediate)
        }
        self.currentActivityId = nil
        promise.resolve(nil)
      }
    }
  }
}
