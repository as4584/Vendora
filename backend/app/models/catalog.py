"""Resqlo universal catalog: one code per real product (style code + size).

Every pair of the same shoe in the same size shares one Resqlo code
(``RQ-XXXXXXX``), in every store. Manufacturer barcodes seen by any store
point at it, so a scan anywhere fills the item in. Only product facts are
stored here - never prices, quantities, condition or anything about a store.
"""
import uuid

from sqlalchemy import Column, ForeignKey, Index, Integer, String, UniqueConstraint, Uuid

from app.models.base import Base, TimestampMixin


class CatalogProduct(Base, TimestampMixin):
    __tablename__ = "catalog_products"
    __table_args__ = (
        UniqueConstraint("rq_code", name="uq_catalog_products_rq_code"),
        UniqueConstraint("style_code", "size", name="uq_catalog_products_style_size"),
        Index("ix_catalog_products_style", "style_code"),
    )

    id = Column(Uuid, primary_key=True, default=uuid.uuid4)
    rq_code = Column(String(16), nullable=False)
    style_code = Column(String(64), nullable=False)
    size = Column(String(32), nullable=False, default="", server_default="")
    name = Column(String(200), nullable=False)
    brand = Column(String(200), nullable=True)
    category = Column(String(200), nullable=True)
    color = Column(String(200), nullable=True)
    times_confirmed = Column(Integer, nullable=False, default=1, server_default="1")


class CatalogBarcode(Base, TimestampMixin):
    __tablename__ = "catalog_barcodes"

    code = Column(String(64), primary_key=True)
    product_id = Column(Uuid, ForeignKey("catalog_products.id", ondelete="CASCADE"), nullable=False, index=True)
