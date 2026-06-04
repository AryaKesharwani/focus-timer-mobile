import ActivityKit
import Foundation

public struct FocusTimerAttributes: ActivityAttributes {
  public struct ContentState: Codable, Hashable {
    public var endTime: Date
    public var mode: String
    public var label: String
    public var isPaused: Bool
    public var pausedRemainingSec: Double

    public init(endTime: Date, mode: String, label: String, isPaused: Bool, pausedRemainingSec: Double) {
      self.endTime = endTime
      self.mode = mode
      self.label = label
      self.isPaused = isPaused
      self.pausedRemainingSec = pausedRemainingSec
    }
  }

  public var startTime: Date
  public var totalDuration: TimeInterval

  public init(startTime: Date, totalDuration: TimeInterval) {
    self.startTime = startTime
    self.totalDuration = totalDuration
  }
}
