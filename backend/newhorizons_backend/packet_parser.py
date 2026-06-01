from __future__ import annotations

import struct
from typing import Any


HEADER_LEN = 20
HEADER_PREFIX_STRUCT = struct.Struct("<HBB")
HEADER_TAIL_STRUCT = struct.Struct("<IIH")
MAGIC = 0xA55A
PACKET_VERSION = 2
ARDUINO_PACKET_VERSION = 3
IMU_BYTES = 7 * 4
BATTERY_BYTES = 4


class PacketParseError(ValueError):
    pass


def infer_sensor_count(flags: int, payload_len: int) -> int:
    matrix_bytes = payload_len
    if flags & 0x01:
        matrix_bytes -= IMU_BYTES
    if flags & 0x02:
        matrix_bytes -= BATTERY_BYTES
    if matrix_bytes < 0 or matrix_bytes % 4 != 0:
        raise PacketParseError("invalid_payload_layout")
    return matrix_bytes // 4


def parse_binary_packet(payload: bytes, sensor_count: int | None = None, device_uid: str | None = None) -> dict[str, Any]:
    if len(payload) < HEADER_LEN:
        raise PacketParseError("packet_too_short")

    magic, version, flags = HEADER_PREFIX_STRUCT.unpack_from(payload, 0)
    if magic != MAGIC:
        raise PacketParseError("invalid_magic")
    if version not in {PACKET_VERSION, ARDUINO_PACKET_VERSION}:
        raise PacketParseError("unsupported_version")
    packet_device_uid = payload[4:10].hex().upper()
    if len(packet_device_uid) != 12:
        raise PacketParseError("invalid_device_uid")
    frame_id, timestamp_ms, payload_len = HEADER_TAIL_STRUCT.unpack_from(payload, 10)

    expected_len = HEADER_LEN + payload_len
    if len(payload) < expected_len:
        raise PacketParseError("truncated_payload")

    if sensor_count is None:
        sensor_count = infer_sensor_count(flags, payload_len)

    matrix_end = HEADER_LEN + (sensor_count * 4)
    if matrix_end > expected_len:
        raise PacketParseError("sensor_count_out_of_range")

    matrix = _round_list(struct.unpack("<" + ("f" * sensor_count), payload[HEADER_LEN:matrix_end])) if sensor_count else []
    offset = matrix_end

    imu_payload = None
    acc = None
    gyro = None
    if flags & 0x01:
        imu_values = list(struct.unpack("<7f", payload[offset:offset + IMU_BYTES]))
        offset += IMU_BYTES
        acc = _round_list(imu_values[0:3])
        gyro = _round_list(imu_values[3:6])
        imu_payload = {
            "acc": acc,
            "gyro": gyro,
            "temperature_c": round(float(imu_values[6]), 6),
        }

    battery_payload = None
    if flags & 0x02:
        status, fault, vbat_mv = struct.unpack("<BBH", payload[offset:offset + BATTERY_BYTES])
        offset += BATTERY_BYTES
        battery_payload = {
            "status": int(status),
            "fault": int(fault),
            "vbat_mv": int(vbat_mv),
        }

    dn = device_uid or packet_device_uid
    return {
        "protocol": "NHO/Arduino/1" if version == ARDUINO_PACKET_VERSION else "NewHorizons/Binary/2",
        "dn": dn,
        "device_uid": dn,
        "device_id": dn,
        "packet_device_uid": packet_device_uid,
        "packet_version": int(version),
        "frame_id": int(frame_id),
        "timestamp_ms": int(timestamp_ms),
        "ts": float(timestamp_ms) / 1000.0,
        "sn": int(sensor_count),
        "p": matrix,
        "acc": acc,
        "gyro": gyro,
        "imu": imu_payload,
        "battery": battery_payload,
        "flags": int(flags),
    }


def _round_list(values: Any) -> list[float]:
    return [round(float(value), 6) for value in values]
