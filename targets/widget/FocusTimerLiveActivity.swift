import ActivityKit
import SwiftUI
import WidgetKit

@available(iOS 16.2, *)
struct FocusTimerLiveActivity: Widget {
  var body: some WidgetConfiguration {
    ActivityConfiguration(for: FocusTimerAttributes.self) { context in
      LockScreenView(context: context)
        .activityBackgroundTint(Color.black.opacity(0.85))
        .activitySystemActionForegroundColor(.white)
    } dynamicIsland: { context in
      DynamicIsland {
        DynamicIslandExpandedRegion(.leading) {
          Image(systemName: iconForMode(context.state.mode))
            .foregroundColor(colorForMode(context.state.mode))
            .font(.title2)
            .padding(.leading, 4)
        }
        DynamicIslandExpandedRegion(.trailing) {
          countdownText(state: context.state)
            .font(.title2.monospacedDigit())
            .foregroundColor(.white)
            .padding(.trailing, 4)
        }
        DynamicIslandExpandedRegion(.bottom) {
          VStack(alignment: .leading, spacing: 6) {
            Text(displayTitle(for: context.state))
              .font(.headline)
              .foregroundColor(.white)
              .lineLimit(1)
            if context.state.isPaused {
              Text("Paused")
                .font(.caption)
                .foregroundColor(.gray)
            } else {
              ProgressView(
                timerInterval: context.attributes.startTime...context.state.endTime,
                countsDown: false
              )
              .tint(colorForMode(context.state.mode))
            }
          }
          .padding(.horizontal, 4)
        }
      } compactLeading: {
        Image(systemName: iconForMode(context.state.mode))
          .foregroundColor(colorForMode(context.state.mode))
      } compactTrailing: {
        countdownText(state: context.state)
          .monospacedDigit()
          .foregroundColor(.white)
      } minimal: {
        Image(systemName: iconForMode(context.state.mode))
          .foregroundColor(colorForMode(context.state.mode))
      }
      .keylineTint(colorForMode(context.state.mode))
    }
  }

  @ViewBuilder
  private func countdownText(state: FocusTimerAttributes.ContentState) -> some View {
    if state.isPaused {
      Text(formatPaused(state.pausedRemainingSec))
    } else {
      Text(timerInterval: Date.now...state.endTime, countsDown: true)
        .multilineTextAlignment(.center)
    }
  }

  private func displayTitle(for state: FocusTimerAttributes.ContentState) -> String {
    if !state.label.isEmpty { return state.label }
    return titleForMode(state.mode)
  }

  private func formatPaused(_ secs: Double) -> String {
    let s = Int(max(0, secs))
    return String(format: "%02d:%02d", s / 60, s % 60)
  }

  private func iconForMode(_ mode: String) -> String {
    switch mode {
    case "focus": return "brain.head.profile"
    case "longBreak": return "leaf.fill"
    default: return "cup.and.saucer.fill"
    }
  }

  private func colorForMode(_ mode: String) -> Color {
    switch mode {
    case "focus": return Color(red: 0.486, green: 0.361, blue: 1.0)
    case "longBreak": return Color(red: 0.239, green: 0.863, blue: 0.592)
    default: return Color(red: 0.357, green: 0.753, blue: 0.922)
    }
  }

  private func titleForMode(_ mode: String) -> String {
    switch mode {
    case "focus": return "Focusing"
    case "longBreak": return "Long break"
    default: return "Short break"
    }
  }
}

@available(iOS 16.2, *)
struct LockScreenView: View {
  let context: ActivityViewContext<FocusTimerAttributes>

  var body: some View {
    HStack(alignment: .center, spacing: 16) {
      VStack(alignment: .leading, spacing: 6) {
        HStack(spacing: 8) {
          Image(systemName: icon)
            .foregroundColor(color)
            .font(.subheadline)
          Text(title)
            .font(.subheadline.weight(.semibold))
            .foregroundColor(.white)
            .lineLimit(1)
        }
        Text(subtitle)
          .font(.caption2)
          .foregroundColor(.gray)
        if !context.state.isPaused {
          ProgressView(
            timerInterval: context.attributes.startTime...context.state.endTime,
            countsDown: false
          )
          .tint(color)
        }
      }
      Spacer(minLength: 8)
      countdown
        .font(.system(size: 30, weight: .light, design: .rounded))
        .monospacedDigit()
        .foregroundColor(.white)
    }
    .padding(.horizontal, 16)
    .padding(.vertical, 12)
  }

  @ViewBuilder
  private var countdown: some View {
    if context.state.isPaused {
      let s = Int(max(0, context.state.pausedRemainingSec))
      Text(String(format: "%02d:%02d", s / 60, s % 60))
    } else {
      Text(timerInterval: Date.now...context.state.endTime, countsDown: true)
    }
  }

  private var title: String {
    if !context.state.label.isEmpty { return context.state.label }
    switch context.state.mode {
    case "focus": return "Focusing"
    case "longBreak": return "Long break"
    default: return "Short break"
    }
  }

  private var subtitle: String {
    if context.state.isPaused { return "Paused" }
    let f = DateFormatter()
    f.timeStyle = .short
    return "Until \(f.string(from: context.state.endTime))"
  }

  private var icon: String {
    switch context.state.mode {
    case "focus": return "brain.head.profile"
    case "longBreak": return "leaf.fill"
    default: return "cup.and.saucer.fill"
    }
  }

  private var color: Color {
    switch context.state.mode {
    case "focus": return Color(red: 0.486, green: 0.361, blue: 1.0)
    case "longBreak": return Color(red: 0.239, green: 0.863, blue: 0.592)
    default: return Color(red: 0.357, green: 0.753, blue: 0.922)
    }
  }
}
