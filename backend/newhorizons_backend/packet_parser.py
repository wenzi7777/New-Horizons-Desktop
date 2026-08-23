from __future__ import annotations

import struct
from typing import Any


HEADER_LEN = 20
HEADER_PREFIX_STRUCT = struct.Struct("<HBB")
HEADER_TAIL_STRUCT = struct.Struct("<IIH")
HEADER_LEN_V4 = 24
HEADER_TAIL_STRUCT_V4 = struct.Struct("<IQH")
MAGIC = 0xA55A
PACKET_VERSION = 2
ARDUINO_PACKET_VERSION = 3
ARDUINO_PACKET_VERSION_V4 = 4
ARDUINO_PACKET_VERSION_V5 = 5
IMU_BYTES = 7 * 4
MAG_BYTES = 3 * 4
BATTERY_BYTES = 4
BATTERY_BYTES_V5 = 6
FLAG_IMU = 0x01
FLAG_BATTERY = 0x02
FLAG_MAG = 0x04
FLAG_RAWADC = 0x08
FLAG_EPOCH_VALID = 0x10
FLAG_EXTENSIONS = 0x20
FLAG_HMAC = 0x40
FLAG_HEARTBEAT = 0x80


class PacketParseError(ValueError):
    pass


def infer_sensor_count(flags: int, payload_len: int, *, version: int = ARDUINO_PACKET_VERSION) -> int:
    matrix_bytes = payload_len
    if flags & FLAG_IMU:
        matrix_bytes -= IMU_BYTES
    if flags & FLAG_MAG:
        matrix_bytes -= MAG_BYTES
    if flags & FLAG_BATTERY:
        matrix_bytes -= BATTERY_BYTES_V5 if version == ARDUINO_PACKET_VERSION_V5 else BATTERY_BYTES
    # When raw ADC streaming is on, the matrix region carries two parallel
    # float arrays per sensor: the calibrated level and the raw reading.
    bytes_per_sensor = 8 if flags & FLAG_RAWADC else 4
    if matrix_bytes < 0 or matrix_bytes % bytes_per_sensor != 0:
        raise PacketParseError("invalid_payload_layout")
    return matrix_bytes // bytes_per_sensor


def _parse_extensions(payload: bytes) -> list[dict[str, Any]]:
    extensions: list[dict[str, Any]] = []
    offset = 0
    while offset < len(payload):
        if len(payload) - offset < 2:
            raise PacketParseError("invalid_extension_layout")
        extension_type = payload[offset]
        extension_len = payload[offset + 1]
        offset += 2
        end = offset + extension_len
        if end > len(payload):
            raise PacketParseError("invalid_extension_layout")
        extensions.append({"type": int(extension_type), "value": payload[offset:end]})
        offset = end
    return extensions


def _split_v5_extensions(flags: int, payload: bytes, sensor_count: int | None) -> tuple[bytes, list[dict[str, Any]]]:
    if not flags & FLAG_EXTENSIONS:
        return payload, []
    if sensor_count is not None:
        base_len = (sensor_count * (8 if flags & FLAG_RAWADC else 4)) + (IMU_BYTES if flags & FLAG_IMU else 0) + (MAG_BYTES if flags & FLAG_MAG else 0) + (BATTERY_BYTES_V5 if flags & FLAG_BATTERY else 0)
        if base_len > len(payload):
            raise PacketParseError("sensor_count_out_of_range")
        return payload[:base_len], _parse_extensions(payload[base_len:])

    fixed_len = (IMU_BYTES if flags & FLAG_IMU else 0) + (MAG_BYTES if flags & FLAG_MAG else 0) + (BATTERY_BYTES_V5 if flags & FLAG_BATTERY else 0)
    bytes_per_sensor = 8 if flags & FLAG_RAWADC else 4
    for base_len in range(fixed_len, len(payload) + 1, bytes_per_sensor):
        try:
            extensions = _parse_extensions(payload[base_len:])
        except PacketParseError:
            continue
        if extensions:
            return payload[:base_len], extensions
    # EXTENSIONS permits zero items; this is only unambiguous when all bytes are base payload.
    if (len(payload) - fixed_len) % bytes_per_sensor == 0:
        return payload, []
    raise PacketParseError("invalid_extension_layout")


def parse_binary_packet(payload: bytes, sensor_count: int | None = None, device_uid: str | None = None) -> dict[str, Any]:
    if len(payload) < HEADER_LEN:
        raise PacketParseError("packet_too_short")

    magic, version, flags = HEADER_PREFIX_STRUCT.unpack_from(payload, 0)
    if magic != MAGIC:
        raise PacketParseError("invalid_magic")
    if version not in {PACKET_VERSION, ARDUINO_PACKET_VERSION, ARDUINO_PACKET_VERSION_V4, ARDUINO_PACKET_VERSION_V5}:
        raise PacketParseError("unsupported_version")
    packet_device_uid = payload[4:10].hex().upper()
    if len(packet_device_uid) != 12:
        raise PacketParseError("invalid_device_uid")

    epoch_ms: int | None = None
    if version in {ARDUINO_PACKET_VERSION_V4, ARDUINO_PACKET_VERSION_V5}:
        if len(payload) < HEADER_LEN_V4:
            raise PacketParseError("packet_too_short")
        header_len = HEADER_LEN_V4
        frame_id, raw_timestamp, payload_len = HEADER_TAIL_STRUCT_V4.unpack_from(payload, 10)
        if flags & FLAG_EPOCH_VALID:
            epoch_ms = int(raw_timestamp)
        timestamp_ms = raw_timestamp
    else:
        header_len = HEADER_LEN
        frame_id, timestamp_ms, payload_len = HEADER_TAIL_STRUCT.unpack_from(payload, 10)

    expected_len = header_len + payload_len
    if len(payload) < expected_len:
        raise PacketParseError("truncated_payload")

    base_payload, extensions = _split_v5_extensions(flags, payload[header_len:expected_len], sensor_count) if version == ARDUINO_PACKET_VERSION_V5 else (payload[header_len:expected_len], [])
    base_payload_len = len(base_payload)
    if sensor_count is None:
        sensor_count = infer_sensor_count(flags, base_payload_len, version=version)

    matrix_end = header_len + (sensor_count * 4)
    base_expected_len = header_len + base_payload_len
    if matrix_end > base_expected_len:
        raise PacketParseError("sensor_count_out_of_range")

    matrix = _round_list(struct.unpack("<" + ("f" * sensor_count), payload[header_len:matrix_end])) if sensor_count else []
    offset = matrix_end

    raw_adc = None
    if flags & FLAG_RAWADC:
        raw_end = offset + (sensor_count * 4)
        if raw_end > base_expected_len:
            raise PacketParseError("sensor_count_out_of_range")
        raw_adc = _round_list(struct.unpack("<" + ("f" * sensor_count), payload[offset:raw_end])) if sensor_count else []
        offset = raw_end

    imu_payload = None
    acc = None
    gyro = None
    if flags & FLAG_IMU:
        if offset + IMU_BYTES > base_expected_len:
            raise PacketParseError("invalid_payload_layout")
        imu_values = list(struct.unpack("<7f", payload[offset:offset + IMU_BYTES]))
        offset += IMU_BYTES
        acc = _round_list(imu_values[0:3])
        gyro = _round_list(imu_values[3:6])
        imu_payload = {
            "acc": acc,
            "gyro": gyro,
            "temperature_c": round(float(imu_values[6]), 6),
        }

    mag = None
    if flags & FLAG_MAG:
        if offset + MAG_BYTES > base_expected_len:
            raise PacketParseError("invalid_payload_layout")
        mag = _round_list(struct.unpack("<3f", payload[offset:offset + MAG_BYTES]))
        offset += MAG_BYTES
        if imu_payload is None:
            imu_payload = {}
        imu_payload["mag"] = mag

    battery_payload = None
    if flags & FLAG_BATTERY:
        battery_bytes = BATTERY_BYTES_V5 if version == ARDUINO_PACKET_VERSION_V5 else BATTERY_BYTES
        if offset + battery_bytes > base_expected_len:
            raise PacketParseError("invalid_payload_layout")
        if version == ARDUINO_PACKET_VERSION_V5:
            status, fault, vbat_mv, soc_centi_percent = struct.unpack("<BBHH", payload[offset:offset + battery_bytes])
        else:
            status, fault, vbat_mv = struct.unpack("<BBH", payload[offset:offset + battery_bytes])
        offset += battery_bytes
        battery_payload = {
            "status": int(status),
            "fault": int(fault),
            "vbat_mv": int(vbat_mv),
        }
        if version == ARDUINO_PACKET_VERSION_V5:
            battery_payload["soc_centi_percent"] = int(soc_centi_percent)
            battery_payload["soc_percent"] = float(soc_centi_percent) / 100.0

    if offset != base_expected_len:
        raise PacketParseError("invalid_payload_layout")

    dn = device_uid or packet_device_uid
    result = {
        "protocol": "NHO/Arduino/1" if version in (ARDUINO_PACKET_VERSION, ARDUINO_PACKET_VERSION_V4, ARDUINO_PACKET_VERSION_V5) else "NewHorizons/Binary/2",
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
        "raw_adc": raw_adc,
        "acc": acc,
        "gyro": gyro,
        "mag": mag,
        "imu": imu_payload,
        "battery": battery_payload,
        "extensions": extensions,
        "flags": int(flags),
    }
    if epoch_ms is not None:
        result["device_epoch_ms"] = epoch_ms
    return result


def _round_list(values: Any) -> list[float]:
    return [round(float(value), 6) for value in values]
