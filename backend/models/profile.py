from typing import Literal, Optional

from pydantic import BaseModel, Field


class VisualProfile(BaseModel):
    model_config = {"populate_by_name": True}

    profile_id: str = Field(alias="profileId")
    max_visible_blocks: int = Field(alias="maxVisibleBlocks", ge=1, le=50)
    spacing_multiplier: float = Field(alias="spacingMultiplier", ge=1.0, le=3.0)
    text_scale: float = Field(alias="textScale", ge=0.8, le=2.5)
    preferred_region: Optional[Literal["left", "right", "center", "top"]] = Field(
        default=None, alias="preferredRegion"
    )
    contrast_mode: Literal["standard", "enhanced"] = Field(
        default="standard", alias="contrastMode"
    )
    reduce_motion: bool = Field(default=False, alias="reduceMotion")
    progressive_reveal: bool = Field(default=False, alias="progressiveReveal")
    simplification_strength: float = Field(
        alias="simplificationStrength", ge=0.0, le=1.0
    )
    # "usage" is the frontend's passively-derived profile (content/usageTracker.ts):
    # built from ordinary browsing rather than the calibration wizard, but the
    # same shape and treated identically everywhere downstream.
    source: Literal["calibration", "usage", "manual", "default"] = "default"
