from django.db import models
from django.contrib.auth.models import User

# Create your models here.

class Message(models.Model):
    description = models.TextField()
    user = models.ForeignKey(User, on_delete=models.CASCADE)
    to_user = models.ForeignKey(User, on_delete=models.CASCADE)